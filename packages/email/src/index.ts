/**
 * @app/email — `EmailProvider` interface + mock/gmail adapters.
 *
 * Mock is the default and is deterministic (injected clock, idempotency-keyed
 * side-effects). Gmail is a stub until `googleapis` + GMAIL_* are wired up.
 */
export * from './types.js';
export { MockEmailProvider, parseWebhookNotification } from './mock.js';
export type {
  MockEmailProviderOptions,
  PreseedThread,
  PreseedMessage,
} from './mock.js';
export { GmailProvider } from './gmail.js';
export type { GmailProviderConfig } from './gmail.js';
export { createEmailProvider } from './factory.js';
export type { CreateEmailProviderOptions } from './factory.js';
