import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribe-token.js';

describe('unsubscribe-token', () => {
  const secret = 'top-secret-key';

  it('round-trips sign -> verify', () => {
    const token = signUnsubscribeToken({ email: 'target@acme.com' }, secret);
    expect(verifyUnsubscribeToken(token, secret)).toEqual({ email: 'target@acme.com' });
  });

  it('round-trips email + domain', () => {
    const token = signUnsubscribeToken({ email: 'a@acme.com', domain: 'acme.com' }, secret);
    expect(verifyUnsubscribeToken(token, secret)).toEqual({
      email: 'a@acme.com',
      domain: 'acme.com',
    });
  });

  it('is deterministic without issuedAt', () => {
    const a = signUnsubscribeToken({ email: 'target@acme.com' }, secret);
    const b = signUnsubscribeToken({ email: 'target@acme.com' }, secret);
    expect(a).toBe(b);
  });

  it('varies when issuedAt is supplied', () => {
    const a = signUnsubscribeToken({ email: 'target@acme.com' }, secret, { issuedAt: 1 });
    const b = signUnsubscribeToken({ email: 'target@acme.com' }, secret, { issuedAt: 2 });
    expect(a).not.toBe(b);
  });

  it('returns null for a tampered payload', () => {
    const token = signUnsubscribeToken({ email: 'target@acme.com' }, secret);
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'attacker@evil.com' }), 'utf8').toString(
      'base64url',
    );
    expect(verifyUnsubscribeToken(`${forged}.${sig}`, secret)).toBeNull();
  });

  it('returns null for a tampered signature', () => {
    const token = signUnsubscribeToken({ email: 'target@acme.com' }, secret);
    const [payload] = token.split('.');
    expect(verifyUnsubscribeToken(`${payload}.deadbeef`, secret)).toBeNull();
  });

  it('returns null for the wrong secret', () => {
    const token = signUnsubscribeToken({ email: 'target@acme.com' }, secret);
    expect(verifyUnsubscribeToken(token, 'different-secret')).toBeNull();
  });

  it('throws when signing an empty payload (no email or domain)', () => {
    expect(() => signUnsubscribeToken({}, secret)).toThrow(/email or domain/);
    // Empty-string fields are dropped by canonicalization → also empty → throws.
    expect(() => signUnsubscribeToken({ email: '', domain: '' }, secret)).toThrow(/email or domain/);
  });

  it('returns null for a valid-signature token whose payload has no target', () => {
    // Hand-craft a properly-signed token whose payload is {} (bypassing the
    // sign-time guard) to prove verify rejects an empty target too.
    const payloadB64 = Buffer.from(JSON.stringify({}), 'utf8').toString('base64url');
    const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
    expect(verifyUnsubscribeToken(`${payloadB64}.${sig}`, secret)).toBeNull();
  });

  it('returns null for missing/malformed tokens', () => {
    expect(verifyUnsubscribeToken(undefined, secret)).toBeNull();
    expect(verifyUnsubscribeToken(null, secret)).toBeNull();
    expect(verifyUnsubscribeToken('', secret)).toBeNull();
    expect(verifyUnsubscribeToken('no-dot', secret)).toBeNull();
    expect(verifyUnsubscribeToken('.sig', secret)).toBeNull();
    expect(verifyUnsubscribeToken('payload.', secret)).toBeNull();
  });
});
