/**
 * Gmail `EmailProvider` adapter — STUB.
 *
 * `googleapis` is intentionally not installed in this repo, so every method
 * throws `ProviderError` until the adapter is wired up. The constructor already
 * accepts the OAuth config so the real implementation can be dropped in without
 * touching call sites.
 *
 * Real Gmail mapping (for when this is implemented against `googleapis`):
 *   - getThread(threadId)         → gmail.users.threads.get({ userId, id })
 *                                   then decode each message's MIME parts into
 *                                   EmailMessageDTO (headers → from/to/subject,
 *                                   base64url body, internalDate → receivedAt).
 *   - createDraft(input)          → gmail.users.drafts.create({ userId,
 *                                   requestBody: { message: { raw } } }); build
 *                                   `raw` as a base64url RFC 5322 MIME string;
 *                                   set threadId for replies.
 *   - sendMessage(input)          → gmail.users.messages.send (or
 *                                   drafts.send({ id: draftId }) when sending a
 *                                   stored draft); returns id + threadId.
 *   - replyToThread(input)        → messages.send with In-Reply-To/References
 *                                   headers and threadId set to the thread.
 *   - watchMailbox(input)         → gmail.users.watch({ userId,
 *                                   requestBody: { topicName, labelIds } });
 *                                   returns { historyId, expiration }.
 *   - parseWebhookNotification    → decode the Pub/Sub push envelope
 *                                   (message.data is base64 JSON
 *                                   { emailAddress, historyId }); follow up with
 *                                   users.history.list({ startHistoryId }) to
 *                                   fetch the new messages.
 * Idempotency: persist idempotencyKey → providerMessageId (e.g. via the
 * `IdempotencyKey` table) and short-circuit duplicate sends before calling the
 * API; optionally set a custom Message-Id header derived from the key.
 */

import { ProviderError } from '@app/shared';
import type {
  CreateDraftInput,
  EmailDraftDTO,
  EmailProvider,
  EmailThreadDTO,
  ReplyToThreadInput,
  SendMessageInput,
  SendResult,
  WatchMailboxInput,
  WatchResult,
  WebhookNotification,
} from './types.js';

/** OAuth/config the real Gmail client needs. Values come from `Config`. */
export interface GmailProviderConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  redirectUri?: string;
  /** The mailbox to act as (Gmail `userId`, e.g. an email or `me`). */
  user?: string;
}

const NOT_CONFIGURED =
  'gmail provider not configured — set GMAIL_* env and install googleapis';

export class GmailProvider implements EmailProvider {
  readonly name = 'gmail' as const;

  private readonly config: GmailProviderConfig;

  constructor(config: GmailProviderConfig) {
    this.config = config;
  }

  private fail(method: string): never {
    throw new ProviderError(NOT_CONFIGURED, { provider: this.name, method });
  }

  async getThread(_threadId: string): Promise<EmailThreadDTO> {
    return this.fail('getThread');
  }

  async createDraft(_input: CreateDraftInput): Promise<EmailDraftDTO> {
    return this.fail('createDraft');
  }

  async sendMessage(_input: SendMessageInput): Promise<SendResult> {
    return this.fail('sendMessage');
  }

  async replyToThread(_input: ReplyToThreadInput): Promise<SendResult> {
    return this.fail('replyToThread');
  }

  async watchMailbox(_input: WatchMailboxInput): Promise<WatchResult> {
    return this.fail('watchMailbox');
  }

  parseWebhookNotification(_payload: unknown): WebhookNotification {
    return this.fail('parseWebhookNotification');
  }
}
