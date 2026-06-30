import { describe, it, expect } from 'vitest';
import { buildUnsubscribeHeaders } from './unsubscribe-headers.js';
import { FakeSettingsReader } from './fakes.js';

describe('buildUnsubscribeHeaders', () => {
  const recipient = 'target@acme.com';

  it('returns {} when unsubscribe is NOT configured (readiness off)', () => {
    const settings = new FakeSettingsReader({ unsubscribeConfigured: false });
    const h = buildUnsubscribeHeaders({
      settings,
      config: { unsubscribeBaseUrl: 'https://example.com/u', unsubscribeMailto: 'unsub@example.com' },
      recipient,
    });
    expect(h).toEqual({});
  });

  it('returns {} when configured but no mechanism provided', () => {
    const settings = new FakeSettingsReader({ unsubscribeConfigured: true });
    const h = buildUnsubscribeHeaders({ settings, config: {}, recipient });
    expect(h).toEqual({});
  });

  it('emits https header + one-click POST when configured', () => {
    const settings = new FakeSettingsReader({ unsubscribeConfigured: true });
    const h = buildUnsubscribeHeaders({
      settings,
      config: { unsubscribeBaseUrl: 'https://example.com/u' },
      recipient,
    });
    expect(h['List-Unsubscribe']).toContain('https://example.com/u');
    expect(h['List-Unsubscribe']).toContain('email=target%40acme.com');
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('emits mailto-only header WITHOUT one-click POST', () => {
    const settings = new FakeSettingsReader({ unsubscribeConfigured: true });
    const h = buildUnsubscribeHeaders({
      settings,
      config: { unsubscribeMailto: 'unsub@example.com' },
      recipient,
    });
    expect(h['List-Unsubscribe']).toBe('<mailto:unsub@example.com>');
    expect(h['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('emits both mechanisms when both configured', () => {
    const settings = new FakeSettingsReader({ unsubscribeConfigured: true });
    const h = buildUnsubscribeHeaders({
      settings,
      config: { unsubscribeBaseUrl: 'https://example.com/u', unsubscribeMailto: 'unsub@example.com' },
      recipient,
    });
    expect(h['List-Unsubscribe']).toContain('mailto:unsub@example.com');
    expect(h['List-Unsubscribe']).toContain('https://example.com/u');
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('rejects http:// (non-https) base URLs — no one-click', () => {
    const settings = new FakeSettingsReader({ unsubscribeConfigured: true });
    const h = buildUnsubscribeHeaders({
      settings,
      config: { unsubscribeBaseUrl: 'http://example.com/u' },
      recipient,
    });
    // http is not a valid one-click endpoint and there is no other mechanism.
    expect(h).toEqual({});
  });

  it('falls back to mailto when base URL is http:// (non-https)', () => {
    const settings = new FakeSettingsReader({ unsubscribeConfigured: true });
    const h = buildUnsubscribeHeaders({
      settings,
      config: { unsubscribeBaseUrl: 'http://example.com/u', unsubscribeMailto: 'unsub@example.com' },
      recipient,
    });
    expect(h['List-Unsubscribe']).toBe('<mailto:unsub@example.com>');
    expect(h['List-Unsubscribe']).not.toContain('http://example.com/u');
    expect(h['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('uses a signed ?token= when a secret is configured', () => {
    const settings = new FakeSettingsReader({ unsubscribeConfigured: true });
    const h = buildUnsubscribeHeaders({
      settings,
      config: { unsubscribeBaseUrl: 'https://example.com/u', unsubscribeTokenSecret: 'shh' },
      recipient,
    });
    expect(h['List-Unsubscribe']).toContain('token=');
    expect(h['List-Unsubscribe']).not.toContain('email=');
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});
