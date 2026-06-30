import { describe, expect, it } from 'vitest';
import { NotFoundError, ProviderError, idempotencyKey, createLogger } from '@app/shared';
import { EmailDirection } from '@app/shared';
import {
  GmailProvider,
  MockEmailProvider,
  parseWebhookNotification,
  type Clock,
} from './index.js';

const silentLogger = createLogger('email-test', { level: 'silent' });
const fixedClock: Clock = () => new Date('2025-06-01T12:00:00.000Z');

function makeMock(): MockEmailProvider {
  return new MockEmailProvider({ logger: silentLogger, clock: fixedClock });
}

const alice = { email: 'alice@example.com', name: 'Alice' };
const bob = { email: 'bob@prospect.com', name: 'Bob' };

describe('MockEmailProvider.createDraft', () => {
  it('is idempotent: same key returns the same draft', async () => {
    const mock = makeMock();
    const key = idempotencyKey(['draft', bob.email, 'subject']);
    const first = await mock.createDraft({
      to: [bob],
      from: alice,
      subject: 'Hello',
      body: 'Body',
      idempotencyKey: key,
    });
    const second = await mock.createDraft({
      to: [bob],
      from: alice,
      subject: 'Different subject ignored',
      body: 'Different body ignored',
      idempotencyKey: key,
    });
    expect(second.draftId).toBe(first.draftId);
    expect(second).toEqual(first);
  });

  it('produces distinct drafts for distinct keys', async () => {
    const mock = makeMock();
    const a = await mock.createDraft({
      to: [bob],
      from: alice,
      subject: 'A',
      body: 'A',
      idempotencyKey: 'k-a',
    });
    const b = await mock.createDraft({
      to: [bob],
      from: alice,
      subject: 'B',
      body: 'B',
      idempotencyKey: 'k-b',
    });
    expect(a.draftId).not.toBe(b.draftId);
  });
});

describe('MockEmailProvider.sendMessage', () => {
  it('records a sent message into a new thread and is roundtrippable via getThread', async () => {
    const mock = makeMock();
    const result = await mock.sendMessage({
      to: [bob],
      from: alice,
      subject: 'Intro',
      body: 'Nice to meet you',
      idempotencyKey: 'send-1',
    });
    expect(result.providerMessageId).toMatch(/^msg_/);
    expect(result.providerThreadId).toMatch(/^thread_/);
    expect(result.sentAt).toBe('2025-06-01T12:00:00.000Z');

    const thread = await mock.getThread(result.providerThreadId);
    expect(thread.messages).toHaveLength(1);
    const [msg] = thread.messages;
    expect(msg?.direction).toBe(EmailDirection.OUTBOUND);
    expect(msg?.subject).toBe('Intro');
    expect(msg?.from).toEqual(alice);
    expect(msg?.to).toEqual([bob]);
  });

  it('is idempotent on idempotencyKey', async () => {
    const mock = makeMock();
    const a = await mock.sendMessage({
      to: [bob],
      from: alice,
      subject: 'Intro',
      body: 'Body',
      idempotencyKey: 'send-dup',
    });
    const b = await mock.sendMessage({
      to: [bob],
      from: alice,
      subject: 'Intro',
      body: 'Body',
      idempotencyKey: 'send-dup',
    });
    expect(b).toEqual(a);
    const thread = await mock.getThread(a.providerThreadId);
    expect(thread.messages).toHaveLength(1);
  });

  it('sends a previously-created draft and appends to its thread', async () => {
    const mock = makeMock();
    const draft = await mock.createDraft({
      to: [bob],
      from: alice,
      subject: 'Draft subject',
      body: 'Draft body',
      idempotencyKey: 'draft-key',
    });
    const result = await mock.sendMessage({ draftId: draft.draftId, idempotencyKey: 'send-draft' });
    const thread = await mock.getThread(result.providerThreadId);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]?.subject).toBe('Draft subject');
  });
});

describe('MockEmailProvider.replyToThread', () => {
  it('appends a reply to an existing (preseeded) thread', async () => {
    const mock = makeMock();
    const [seeded] = mock.preseed([
      {
        subject: 'Re: Pricing',
        messages: [
          {
            from: bob,
            to: [alice],
            subject: 'Re: Pricing',
            body: 'Can you send pricing?',
            direction: EmailDirection.INBOUND,
          },
        ],
      },
    ]);
    expect(seeded).toBeDefined();
    const threadId = seeded!.providerThreadId;

    const result = await mock.replyToThread({
      threadId,
      to: [bob],
      from: alice,
      body: 'Here is our pricing.',
      idempotencyKey: 'reply-1',
    });
    expect(result.providerThreadId).toBe(threadId);

    const thread = await mock.getThread(threadId);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1]?.direction).toBe(EmailDirection.OUTBOUND);
    expect(thread.messages[1]?.subject).toBe('Re: Pricing');
  });

  it('throws NotFoundError replying to a missing thread', async () => {
    const mock = makeMock();
    await expect(
      mock.replyToThread({
        threadId: 'thread_missing',
        to: [bob],
        from: alice,
        body: 'x',
        idempotencyKey: 'reply-missing',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('MockEmailProvider.getThread', () => {
  it('throws NotFoundError for a missing thread', async () => {
    const mock = makeMock();
    await expect(mock.getThread('thread_does_not_exist')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('parseWebhookNotification', () => {
  it('parses a JSON-string Gmail-style push payload', () => {
    const payload = JSON.stringify({ emailAddress: 'user@example.com', historyId: '987' });
    const n = parseWebhookNotification(payload);
    expect(n.emailAddress).toBe('user@example.com');
    expect(n.historyId).toBe('987');
    expect(n.raw).toEqual({ emailAddress: 'user@example.com', historyId: '987' });
  });

  it('parses an object payload and coerces a numeric historyId', () => {
    const payload = { emailAddress: 'user@example.com', historyId: 42 };
    const n = parseWebhookNotification(payload);
    expect(n.historyId).toBe('42');
    expect(n.emailAddress).toBe('user@example.com');
  });

  it('the mock delegates to the standalone parser', () => {
    const mock = makeMock();
    const n = mock.parseWebhookNotification({ historyId: '5' });
    expect(n.historyId).toBe('5');
  });
});

describe('GmailProvider stub', () => {
  const gmail = new GmailProvider({ user: 'me' });

  it('reports name gmail', () => {
    expect(gmail.name).toBe('gmail');
  });

  it('throws ProviderError from async methods', async () => {
    await expect(gmail.getThread('t')).rejects.toBeInstanceOf(ProviderError);
    await expect(
      gmail.createDraft({ to: [bob], from: alice, subject: 's', body: 'b', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(
      gmail.sendMessage({ to: [bob], from: alice, subject: 's', body: 'b', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(
      gmail.replyToThread({ threadId: 't', to: [bob], from: alice, body: 'b', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(gmail.watchMailbox({ emailAddress: 'me' })).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError from parseWebhookNotification', () => {
    expect(() => gmail.parseWebhookNotification({})).toThrow(ProviderError);
  });
});
