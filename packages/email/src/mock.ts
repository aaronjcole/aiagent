/**
 * In-memory, deterministic `EmailProvider` for local dev and tests.
 *
 * Determinism: ids are derived from `newId`/the caller's `idempotencyKey`, and
 * timestamps come from an injected `clock` (defaulting to a fixed epoch) rather
 * than `Date.now()`. This makes thread/message ordering and persisted ids
 * reproducible across runs.
 *
 * Policy note: the mock does NOT enforce any send policy (suppression, caps,
 * compliance, kill switch). Those live in the workflow/compliance layer. The
 * mock simply records the side-effect and logs a clear `MOCK email send` line.
 */

import { newId, NotFoundError, type Logger } from '@app/shared';
import { EmailDirection } from '@app/shared';
import type {
  Clock,
  CreateDraftInput,
  EmailAddress,
  EmailDraftDTO,
  EmailMessageDTO,
  EmailProvider,
  EmailThreadDTO,
  ReplyToThreadInput,
  SendMessageInput,
  SendResult,
  WatchMailboxInput,
  WatchResult,
  WebhookNotification,
} from './types.js';

/** Fixed default epoch so timestamps are deterministic without an injected clock. */
const DEFAULT_EPOCH = new Date('2025-01-01T00:00:00.000Z');

/** A message/thread to preseed (e.g. to simulate an inbound reply in the demo). */
export interface PreseedMessage {
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  body: string;
  direction: EmailDirection;
  /** Optional explicit timestamp; defaults to the clock value. */
  receivedAt?: string;
  /** Optional explicit provider message id; defaults to a generated id. */
  providerMessageId?: string;
  /** Optional snippet; defaults to a truncated body. */
  snippet?: string;
}

export interface PreseedThread {
  /** Optional explicit thread id; defaults to a generated id. */
  providerThreadId?: string;
  subject: string;
  messages: PreseedMessage[];
}

export interface MockEmailProviderOptions {
  logger: Logger;
  /** Deterministic clock; defaults to a fixed epoch. */
  clock?: Clock;
}

function snippetOf(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > 100 ? `${collapsed.slice(0, 100)}…` : collapsed;
}

export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock' as const;

  private readonly threads = new Map<string, EmailThreadDTO>();
  private readonly messages = new Map<string, EmailMessageDTO>();
  /** Drafts keyed by draftId. */
  private readonly drafts = new Map<string, EmailDraftDTO>();
  /** idempotencyKey → draftId (for createDraft idempotency). */
  private readonly draftKeys = new Map<string, string>();
  /** idempotencyKey → SendResult (for send/reply idempotency). */
  private readonly sendResults = new Map<string, SendResult>();

  private readonly logger: Logger;
  private readonly clock: Clock;

  constructor(options: MockEmailProviderOptions) {
    this.logger = options.logger;
    this.clock = options.clock ?? (() => DEFAULT_EPOCH);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  /**
   * Preseed threads/messages into the in-memory store. Returns the created
   * thread DTOs so callers can grab the generated ids. Used by the demo to
   * simulate an existing conversation / inbound reply.
   */
  preseed(threads: readonly PreseedThread[]): EmailThreadDTO[] {
    const created: EmailThreadDTO[] = [];
    for (const seed of threads) {
      const threadId = seed.providerThreadId ?? newId('thread');
      const messages: EmailMessageDTO[] = seed.messages.map((m) => {
        const providerMessageId = m.providerMessageId ?? newId('msg');
        const message: EmailMessageDTO = {
          providerMessageId,
          threadId,
          direction: m.direction,
          from: m.from,
          to: m.to,
          subject: m.subject,
          body: m.body,
          snippet: m.snippet ?? snippetOf(m.body),
          receivedAt: m.receivedAt ?? this.nowIso(),
        };
        this.messages.set(providerMessageId, message);
        return message;
      });
      const thread: EmailThreadDTO = {
        providerThreadId: threadId,
        subject: seed.subject,
        messages,
      };
      this.threads.set(threadId, thread);
      created.push(thread);
    }
    return created;
  }

  /**
   * Return a recorded message by its provider id, or undefined. Exposed so
   * tests can assert recorded fields (e.g. `headers`) on a sent message.
   */
  getRecordedMessage(providerMessageId: string): EmailMessageDTO | undefined {
    const m = this.messages.get(providerMessageId);
    return m ? { ...m } : undefined;
  }

  async getThread(threadId: string): Promise<EmailThreadDTO> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new NotFoundError(`email thread not found: ${threadId}`, { threadId });
    }
    // Return a shallow clone so callers can't mutate our store.
    return { ...thread, messages: [...thread.messages] };
  }

  async createDraft(input: CreateDraftInput): Promise<EmailDraftDTO> {
    const existingId = this.draftKeys.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.drafts.get(existingId);
      if (existing) {
        this.logger.debug({ idempotencyKey: input.idempotencyKey }, 'MOCK draft hit (idempotent)');
        return existing;
      }
    }

    const draftId = newId('draft');
    const draft: EmailDraftDTO = {
      draftId,
      threadId: input.threadId,
      to: input.to,
      from: input.from,
      subject: input.subject,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      createdAt: this.nowIso(),
    };
    this.drafts.set(draftId, draft);
    this.draftKeys.set(input.idempotencyKey, draftId);
    this.logger.debug({ draftId, threadId: input.threadId }, 'MOCK draft created');
    return draft;
  }

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    const existing = this.sendResults.get(input.idempotencyKey);
    if (existing) {
      this.logger.info({ idempotencyKey: input.idempotencyKey }, 'MOCK email send (idempotent hit)');
      return existing;
    }

    // Resolve the message fields from either an inline payload or a stored draft.
    let to: EmailAddress[];
    let from: EmailAddress;
    let subject: string;
    let body: string;
    let threadId: string | undefined = input.threadId;

    if (input.draftId !== undefined) {
      const draft = this.drafts.get(input.draftId);
      if (!draft) {
        throw new NotFoundError(`draft not found: ${input.draftId}`, { draftId: input.draftId });
      }
      to = draft.to;
      from = draft.from;
      subject = draft.subject;
      body = draft.body;
      threadId = threadId ?? draft.threadId;
    } else {
      to = input.to;
      from = input.from;
      subject = input.subject;
      body = input.body;
    }

    return this.record({
      to,
      from,
      subject,
      body,
      threadId,
      direction: EmailDirection.OUTBOUND,
      idempotencyKey: input.idempotencyKey,
      headers: input.headers,
    });
  }

  async replyToThread(input: ReplyToThreadInput): Promise<SendResult> {
    const existing = this.sendResults.get(input.idempotencyKey);
    if (existing) {
      this.logger.info({ idempotencyKey: input.idempotencyKey }, 'MOCK email reply (idempotent hit)');
      return existing;
    }

    const thread = this.threads.get(input.threadId);
    if (!thread) {
      throw new NotFoundError(`email thread not found: ${input.threadId}`, { threadId: input.threadId });
    }

    return this.record({
      to: input.to,
      from: input.from,
      subject: input.subject ?? thread.subject,
      body: input.body,
      threadId: input.threadId,
      direction: EmailDirection.OUTBOUND,
      idempotencyKey: input.idempotencyKey,
      headers: input.headers,
    });
  }

  /** Append an outbound message to a thread (creating the thread if needed). */
  private record(args: {
    to: EmailAddress[];
    from: EmailAddress;
    subject: string;
    body: string;
    threadId?: string;
    direction: EmailDirection;
    idempotencyKey: string;
    headers?: Record<string, string>;
  }): SendResult {
    const sentAt = this.nowIso();
    const providerMessageId = newId('msg');

    let thread = args.threadId ? this.threads.get(args.threadId) : undefined;
    if (!thread) {
      const threadId = args.threadId ?? newId('thread');
      thread = { providerThreadId: threadId, subject: args.subject, messages: [] };
      this.threads.set(threadId, thread);
    }

    const message: EmailMessageDTO = {
      providerMessageId,
      threadId: thread.providerThreadId,
      direction: args.direction,
      from: args.from,
      to: args.to,
      subject: args.subject,
      body: args.body,
      snippet: snippetOf(args.body),
      receivedAt: sentAt,
      ...(args.headers ? { headers: args.headers } : {}),
    };
    thread.messages.push(message);
    this.messages.set(providerMessageId, message);

    const result: SendResult = {
      providerMessageId,
      providerThreadId: thread.providerThreadId,
      sentAt,
    };
    this.sendResults.set(args.idempotencyKey, result);

    this.logger.info(
      {
        provider: this.name,
        providerMessageId,
        providerThreadId: thread.providerThreadId,
        to: args.to.map((a) => a.email),
        subject: args.subject,
      },
      'MOCK email send',
    );
    return result;
  }

  async watchMailbox(input: WatchMailboxInput): Promise<WatchResult> {
    this.logger.info({ emailAddress: input.emailAddress }, 'MOCK watchMailbox registered');
    return { historyId: '1', expiration: this.nowIso() };
  }

  parseWebhookNotification(payload: unknown): WebhookNotification {
    return parseWebhookNotification(payload);
  }
}

/**
 * Parse a simple JSON push payload into a `WebhookNotification`. Accepts either
 * an object or a JSON string. Mirrors the shape Gmail Pub/Sub push delivers
 * (`{ emailAddress, historyId }`), while keeping the original under `raw`.
 */
export function parseWebhookNotification(payload: unknown): WebhookNotification {
  let raw: unknown = payload;
  let obj: Record<string, unknown> | undefined;

  if (typeof payload === 'string') {
    try {
      const parsed: unknown = JSON.parse(payload);
      raw = parsed;
      if (parsed !== null && typeof parsed === 'object') {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      obj = undefined;
    }
  } else if (payload !== null && typeof payload === 'object') {
    obj = payload as Record<string, unknown>;
  }

  const historyId = obj && typeof obj.historyId === 'string' ? obj.historyId : undefined;
  const historyIdNum =
    historyId === undefined && obj && typeof obj.historyId === 'number'
      ? String(obj.historyId)
      : undefined;
  const emailAddress = obj && typeof obj.emailAddress === 'string' ? obj.emailAddress : undefined;

  return {
    historyId: historyId ?? historyIdNum,
    emailAddress,
    raw,
  };
}
