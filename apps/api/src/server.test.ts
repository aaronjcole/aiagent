/**
 * In-process route tests for the Fastify app (ARCH-H1). Uses `app.inject()` with
 * a mocked prisma / Temporal probe — no live DB, no Temporal server. Covers:
 *  - `/health` liveness (always 200, never touches deps),
 *  - `/health/ready` readiness (DB ok + Temporal ok → 200; DB down → 503),
 *  - bearer-auth gating (protected route → 401 without token, 200 with token;
 *    `/health` + `/unsubscribe` exempt),
 *  - unsubscribe token verification (valid signed token suppresses; invalid /
 *    empty token rejected).
 */

import { describe, it, expect, vi } from 'vitest';
import { signUnsubscribeToken } from '@app/shared';
import { buildServer } from './server.js';
import { makeFakeContext } from './test-helpers.js';

const AUTH_TOKEN = 'test-secret-bearer-token';
const UNSUB_SECRET = 'test-unsubscribe-signing-secret';

describe('GET /health (liveness)', () => {
  it('returns 200 {ok:true} without touching the DB or Temporal', async () => {
    // pingTemporal that would throw if called — proves /health never calls it.
    const ctx = makeFakeContext({
      pingTemporal: async () => {
        throw new Error('liveness must not call Temporal');
      },
    });
    const app = buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});

describe('GET /health/ready (readiness)', () => {
  it('returns 200 with all checks ok when DB + Temporal are healthy', async () => {
    const queryRaw = vi.fn(async () => [{ '?column?': 1 }]);
    const ctx = makeFakeContext({
      prisma: { $queryRaw: queryRaw },
      pingTemporal: async () => 'ok',
    });
    const app = buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, checks: { db: 'ok', temporal: 'ok' } });
    expect(queryRaw).toHaveBeenCalledOnce();
    await app.close();
  });

  it('returns 503 with db:error when the DB is down', async () => {
    const ctx = makeFakeContext({
      prisma: {
        $queryRaw: async () => {
          throw new Error('connection refused');
        },
      },
      pingTemporal: async () => 'ok',
    });
    const app = buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe('error');
    expect(body.checks.temporal).toBe('ok');
    // Must not leak connection strings / secrets.
    expect(JSON.stringify(body)).not.toMatch(/postgres|connection refused|password/i);
    await app.close();
  });

  it('returns 503 with temporal:error when Temporal is unreachable', async () => {
    const ctx = makeFakeContext({
      prisma: { $queryRaw: async () => [{ ok: 1 }] },
      pingTemporal: async () => {
        throw new Error('temporal unreachable');
      },
    });
    const app = buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe('ok');
    expect(body.checks.temporal).toBe('error');
    await app.close();
  });

  it('is public (no bearer required) even when a token is configured', async () => {
    const ctx = makeFakeContext({
      env: { API_AUTH_TOKEN: AUTH_TOKEN },
      prisma: { $queryRaw: async () => [{ ok: 1 }] },
    });
    const app = buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('bearer auth gating', () => {
  it('protected route → 401 without a token (when a token is configured)', async () => {
    const ctx = makeFakeContext({
      env: { API_AUTH_TOKEN: AUTH_TOKEN },
      prisma: { suppressionEntry: { findMany: async () => [] } },
    });
    const app = buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/suppression' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('protected route → 401 with a wrong token', async () => {
    const ctx = makeFakeContext({
      env: { API_AUTH_TOKEN: AUTH_TOKEN },
      prisma: { suppressionEntry: { findMany: async () => [] } },
    });
    const app = buildServer(ctx);
    const res = await app.inject({
      method: 'GET',
      url: '/suppression',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('protected route → 200 with the correct token', async () => {
    const ctx = makeFakeContext({
      env: { API_AUTH_TOKEN: AUTH_TOKEN },
      prisma: { suppressionEntry: { findMany: async () => [] } },
    });
    const app = buildServer(ctx);
    const res = await app.inject({
      method: 'GET',
      url: '/suppression',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('protected route → 503 when NODE_ENV=production and no token is configured (fail closed)', async () => {
    const ctx = makeFakeContext({
      env: { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y' },
      prisma: { suppressionEntry: { findMany: async () => [] } },
    });
    const app = buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/suppression' });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('AUTH_NOT_CONFIGURED');
    await app.close();
  });

  it('/health is exempt from auth even with a token configured', async () => {
    const ctx = makeFakeContext({ env: { API_AUTH_TOKEN: AUTH_TOKEN } });
    const app = buildServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('unsubscribe token verification', () => {
  /** Build a prisma double that records the upserted suppression + audit rows. */
  function suppressionPrisma() {
    const upserts: unknown[] = [];
    const audits: unknown[] = [];
    let stored: { id: string; email: string | null; domain: string | null } | null = null;
    const prisma = {
      suppressionEntry: {
        async findUnique() {
          return stored;
        },
        async upsert({ create }: { create: { email: string | null; domain: string | null } }) {
          stored = { id: 'sup_test_1', email: create.email, domain: create.domain };
          upserts.push(create);
          return stored;
        },
      },
      auditLog: {
        async create({ data }: { data: unknown }) {
          audits.push(data);
          return { id: `aud_${audits.length}` };
        },
      },
    };
    return { prisma, upserts, audits };
  }

  it('POST /unsubscribe with a valid signed token suppresses the target (public, no bearer)', async () => {
    const { prisma, upserts } = suppressionPrisma();
    const ctx = makeFakeContext({
      env: { API_AUTH_TOKEN: AUTH_TOKEN, UNSUBSCRIBE_TOKEN_SECRET: UNSUB_SECRET },
      prisma,
    });
    const token = signUnsubscribeToken({ email: 'target@acme.com' }, UNSUB_SECRET);
    const app = buildServer(ctx);
    // No Authorization header — /unsubscribe is public.
    const res = await app.inject({ method: 'POST', url: '/unsubscribe', payload: { token } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unsubscribed).toBe(true);
    expect(body.email).toBe('target@acme.com');
    expect(upserts.length).toBe(1);
    await app.close();
  });

  it('POST /unsubscribe with an invalid token is rejected (400) and suppresses nobody', async () => {
    const { prisma, upserts } = suppressionPrisma();
    const ctx = makeFakeContext({
      env: { UNSUBSCRIBE_TOKEN_SECRET: UNSUB_SECRET },
      prisma,
    });
    const app = buildServer(ctx);
    const res = await app.inject({
      method: 'POST',
      url: '/unsubscribe',
      payload: { token: 'not-a-valid-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(upserts.length).toBe(0);
    await app.close();
  });

  it('POST /unsubscribe with an empty/missing token fails request validation (400)', async () => {
    const { prisma, upserts } = suppressionPrisma();
    const ctx = makeFakeContext({
      env: { UNSUBSCRIBE_TOKEN_SECRET: UNSUB_SECRET },
      prisma,
    });
    const app = buildServer(ctx);
    const res = await app.inject({ method: 'POST', url: '/unsubscribe', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(upserts.length).toBe(0);
    await app.close();
  });
});
