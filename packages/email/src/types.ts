/**
 * Email domain DTOs and the `EmailProvider` interface.
 *
 * These are clean, provider-agnostic shapes the rest of the system codes
 * against. Adapters (mock, gmail) translate between these DTOs and their native
 * representations (Gmail `users.threads`, `messages`, `drafts`, etc.).
 */

import type { EmailDirection } from '@app/shared';

/** A single email address, optionally with a display name. */
export interface EmailAddress {
  email: string;
  name?: string;
}

/**
 * A normalized email message. `providerMessageId`/`threadId` are the provider's
 * stable identifiers; `direction` is from the mailbox owner's perspective.
 */
export interface EmailMessageDTO {
  providerMessageId: string;
  threadId: string;
  direction: EmailDirection;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  body: string;
  snippet: string;
  /** ISO-8601 timestamp the message was sent/received. */
  receivedAt: string;
  /** Extra RFC 5322 headers recorded for this message (e.g. List-Unsubscribe). */
  headers?: Record<string, string>;
}

/** A normalized email thread with its messages in chronological order. */
export interface EmailThreadDTO {
  providerThreadId: string;
  subject: string;
  messages: EmailMessageDTO[];
}

/**
 * Input to create a draft. `threadId` ties the draft to an existing thread (a
 * reply); omit it for a fresh thread. `idempotencyKey` dedupes repeated creates.
 */
export interface CreateDraftInput {
  threadId?: string;
  to: EmailAddress[];
  from: EmailAddress;
  subject: string;
  body: string;
  idempotencyKey: string;
}

/** A stored draft. */
export interface EmailDraftDTO {
  draftId: string;
  threadId?: string;
  to: EmailAddress[];
  from: EmailAddress;
  subject: string;
  body: string;
  idempotencyKey: string;
  createdAt: string;
}

/**
 * Input to send a message. Either reference a previously-created `draftId`, or
 * supply the message fields inline (`to`/`from`/`subject`/`body`). `threadId`
 * scopes the send to an existing thread. `idempotencyKey` dedupes sends.
 */
export type SendMessageInput =
  | {
      draftId: string;
      threadId?: string;
      idempotencyKey: string;
      /** Optional extra RFC 5322 headers (e.g. List-Unsubscribe). */
      headers?: Record<string, string>;
      to?: undefined;
      from?: undefined;
      subject?: undefined;
      body?: undefined;
    }
  | {
      draftId?: undefined;
      to: EmailAddress[];
      from: EmailAddress;
      subject: string;
      body: string;
      threadId?: string;
      idempotencyKey: string;
      /** Optional extra RFC 5322 headers (e.g. List-Unsubscribe). */
      headers?: Record<string, string>;
    };

/** Input to reply within an existing thread. */
export interface ReplyToThreadInput {
  threadId: string;
  to: EmailAddress[];
  from: EmailAddress;
  subject?: string;
  body: string;
  idempotencyKey: string;
  /** Optional extra RFC 5322 headers (e.g. List-Unsubscribe). */
  headers?: Record<string, string>;
}

/** Result of a send/reply: the provider ids of the newly created message. */
export interface SendResult {
  providerMessageId: string;
  providerThreadId: string;
  /** ISO-8601 timestamp the message was sent. */
  sentAt: string;
}

/** Input to register a push/watch subscription on a mailbox. */
export interface WatchMailboxInput {
  /** The mailbox address to watch (e.g. `me` or a specific user). */
  emailAddress: string;
  /** Provider-specific delivery target (e.g. a Pub/Sub topic). */
  topic?: string;
  /** Optional label/folder filter. */
  labelIds?: string[];
}

/** Result of registering a watch. */
export interface WatchResult {
  /** Provider history cursor the next notification will be relative to. */
  historyId?: string;
  /** ISO-8601 expiry of the watch registration, if the provider sets one. */
  expiration?: string;
}

/**
 * A normalized webhook/push notification. Providers deliver an opaque `raw`
 * payload; adapters extract the well-known fields they understand.
 */
export interface WebhookNotification {
  historyId?: string;
  emailAddress?: string;
  /** The original, unparsed payload, retained for auditing/replay. */
  raw: unknown;
}

/**
 * Provider-agnostic email port. Adapters: `mock` (in-memory, deterministic) and
 * `gmail` (stub until wired to the Gmail API + googleapis).
 */
export interface EmailProvider {
  readonly name: 'mock' | 'gmail';

  /** Fetch a thread by its provider id. Throws `NotFoundError` if absent. */
  getThread(threadId: string): Promise<EmailThreadDTO>;

  /** Create (or return an existing, by idempotency key) draft. */
  createDraft(input: CreateDraftInput): Promise<EmailDraftDTO>;

  /** Send a message (new thread or reply). Idempotent on `idempotencyKey`. */
  sendMessage(input: SendMessageInput): Promise<SendResult>;

  /** Append a reply to an existing thread. Idempotent on `idempotencyKey`. */
  replyToThread(input: ReplyToThreadInput): Promise<SendResult>;

  /** Register a push/watch subscription on a mailbox. */
  watchMailbox(input: WatchMailboxInput): Promise<WatchResult>;

  /** Parse a raw webhook/push payload into a `WebhookNotification`. */
  parseWebhookNotification(payload: unknown): WebhookNotification;
}

/** A monotonic clock used for deterministic timestamps in adapters. */
export type Clock = () => Date;
