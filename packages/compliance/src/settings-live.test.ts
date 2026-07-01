import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PrismaClient } from '@app/db';
import { createLiveSettingsReader } from './settings.js';

/**
 * Minimal Prisma double exposing only `systemSetting.findMany`, the sole call
 * `createLiveSettingsReader` makes. `findMany` delegates to a swappable impl so
 * a test can make later refreshes fail.
 */
function fakePrisma(findMany: () => Promise<Array<{ key: string; value: unknown }>>): {
  prisma: PrismaClient;
  calls: () => number;
} {
  let count = 0;
  const systemSetting = {
    async findMany() {
      count += 1;
      return findMany();
    },
  };
  return { prisma: { systemSetting } as unknown as PrismaClient, calls: () => count };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createLiveSettingsReader refresh throttling', () => {
  it('a FAILED refresh does not re-fire on every subsequent read (throttled to TTL)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));

    let mode: 'ok' | 'fail' = 'ok';
    const { prisma, calls } = fakePrisma(async () => {
      if (mode === 'fail') throw new Error('transient DB error');
      return [{ key: 'maxAutoSendsPerDayGlobal', value: 7 }];
    });

    const reader = await createLiveSettingsReader(prisma, { ttlMs: 1000 });
    expect(calls()).toBe(1); // eager initial load
    expect(reader.num('maxAutoSendsPerDayGlobal')).toBe(7);

    // Make refreshes fail, advance past the TTL, and read repeatedly. The stale
    // snapshot is still served, and the FAILED refresh stamps loadedAt so the
    // burst of reads triggers exactly ONE more query, not one per read.
    mode = 'fail';
    vi.advanceTimersByTime(1500);
    reader.num('maxAutoSendsPerDayGlobal'); // triggers a refresh (which will fail)
    await vi.runAllTimersAsync(); // let the failed refresh settle
    const afterFirstStale = calls();
    expect(afterFirstStale).toBe(2);

    // Immediately after the failed refresh, more reads within the TTL must NOT
    // re-query (throttled by the loadedAt stamp set in the catch).
    reader.num('maxAutoSendsPerDayGlobal');
    reader.num('maxAutoSendsPerDayGlobal');
    expect(calls()).toBe(2);
    // Last-good value is still served through the failure.
    expect(reader.num('maxAutoSendsPerDayGlobal')).toBe(7);
  });
});

describe('createLiveSettingsReader forced-fresh refresh (SAFE-3)', () => {
  it('refresh() reloads the snapshot immediately, bypassing the TTL', async () => {
    let flip = false;
    const { prisma, calls } = fakePrisma(async () =>
      flip
        ? [{ key: 'globalPauseAllAutomation', value: true }]
        : [{ key: 'globalPauseAllAutomation', value: false }],
    );

    // Large TTL: without a forced refresh a flip would be served stale.
    const reader = await createLiveSettingsReader(prisma, { ttlMs: 60_000 });
    expect(calls()).toBe(1);
    expect(reader.bool('globalPauseAllAutomation')).toBe(false);

    // Admin flips the kill switch. A plain read within the TTL still sees stale.
    flip = true;
    expect(reader.bool('globalPauseAllAutomation')).toBe(false);
    expect(calls()).toBe(1);

    // A forced-fresh read (as done at the send/book decision point) reloads now.
    expect(reader.refresh).toBeTypeOf('function');
    await reader.refresh?.();
    expect(calls()).toBe(2);
    expect(reader.bool('globalPauseAllAutomation')).toBe(true);
  });

  it('concurrent refresh() calls coalesce into a single query', async () => {
    const { prisma, calls } = fakePrisma(async () => [
      { key: 'globalPauseAllAutomation', value: true },
    ]);
    const reader = await createLiveSettingsReader(prisma, { ttlMs: 60_000 });
    expect(calls()).toBe(1);

    await Promise.all([reader.refresh?.(), reader.refresh?.(), reader.refresh?.()]);
    // The three concurrent forced refreshes coalesce onto one in-flight load.
    expect(calls()).toBe(2);
  });

  it('refresh() swallows a DB error and retains the last-good snapshot', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const { prisma } = fakePrisma(async () => {
      if (mode === 'fail') throw new Error('transient DB error');
      return [{ key: 'globalPauseAllAutomation', value: false }];
    });
    const reader = await createLiveSettingsReader(prisma, { ttlMs: 60_000 });
    expect(reader.bool('globalPauseAllAutomation')).toBe(false);

    mode = 'fail';
    await expect(reader.refresh?.()).resolves.toBeUndefined();
    // Fail-safe: still serves the last-good value rather than throwing.
    expect(reader.bool('globalPauseAllAutomation')).toBe(false);
  });
});
