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
