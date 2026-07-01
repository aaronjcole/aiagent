import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { loadConfig } from './env.js';

describe('env — DATABASE_URL fail-closed in production (OPS-H2)', () => {
  const DEV_DEFAULT = 'postgresql://localhost:5432/aiagent';

  it('production + missing DATABASE_URL → throws a clear config error', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(ZodError);
    try {
      loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    } catch (err) {
      const issues = (err as ZodError).issues;
      const dbIssue = issues.find((i) => i.path[0] === 'databaseUrl');
      expect(dbIssue).toBeDefined();
      expect(dbIssue?.message).toMatch(/DATABASE_URL is required in production/);
    }
  });

  it('production + empty DATABASE_URL → throws (does not fall back to localhost)', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: '   ' } as NodeJS.ProcessEnv),
    ).toThrow(ZodError);
  });

  it('development + missing DATABASE_URL → localhost default retained', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(cfg.databaseUrl).toBe(DEV_DEFAULT);
  });

  it('test + missing DATABASE_URL → localhost default retained', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(cfg.databaseUrl).toBe(DEV_DEFAULT);
  });

  it('default (unset NODE_ENV → development) + missing DATABASE_URL → localhost default', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.databaseUrl).toBe(DEV_DEFAULT);
  });

  it('explicit DATABASE_URL is used verbatim (development)', () => {
    const url = 'postgresql://user:pw@db.example.com:5432/prod';
    const cfg = loadConfig({ NODE_ENV: 'development', DATABASE_URL: url } as NodeJS.ProcessEnv);
    expect(cfg.databaseUrl).toBe(url);
  });

  it('explicit DATABASE_URL is used verbatim (production — passes fail-closed guard)', () => {
    const url = 'postgresql://user:pw@db.example.com:5432/prod';
    const cfg = loadConfig({ NODE_ENV: 'production', DATABASE_URL: url } as NodeJS.ProcessEnv);
    expect(cfg.databaseUrl).toBe(url);
  });
});

describe('env — LIVE_SETTINGS_TTL_MS', () => {
  it('defaults to 5000ms when unset', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(cfg.liveSettingsTtlMs).toBe(5000);
  });

  it('parses an explicit value', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', LIVE_SETTINGS_TTL_MS: '1000' } as NodeJS.ProcessEnv);
    expect(cfg.liveSettingsTtlMs).toBe(1000);
  });

  it('accepts 0 (re-query every read)', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', LIVE_SETTINGS_TTL_MS: '0' } as NodeJS.ProcessEnv);
    expect(cfg.liveSettingsTtlMs).toBe(0);
  });
});
