import { describe, it, expect } from 'vitest';
import { ensureFooter } from './footer.js';
import type { FooterConfig } from './types.js';

const config: FooterConfig = {
  unsubscribeBaseUrl: 'https://example.com/unsubscribe',
  companyAddress: '123 Example St, City, ST 00000, USA',
};

describe('ensureFooter', () => {
  it('appends both pieces when missing', () => {
    const r = ensureFooter('Hello there, great to connect.', config);
    expect(r.added).toBe(true);
    expect(r.hasUnsubscribe).toBe(true);
    expect(r.body).toContain('https://example.com/unsubscribe');
    expect(r.body).toContain('123 Example St');
  });

  it('is idempotent when both pieces are already present', () => {
    const body = `Hi there.\n\n--\nUnsubscribe: ${config.unsubscribeBaseUrl}\n${config.companyAddress}`;
    const r = ensureFooter(body, config);
    expect(r.added).toBe(false);
    expect(r.body).toBe(body);
    expect(r.hasUnsubscribe).toBe(true);
  });

  it('appends only the missing address when unsubscribe is present', () => {
    const body = `Hi.\n\nUnsubscribe here: ${config.unsubscribeBaseUrl}`;
    const r = ensureFooter(body, config);
    expect(r.added).toBe(true);
    expect(r.body).toContain('123 Example St');
    // URL only appears once (was already there).
    expect(r.body.split(config.unsubscribeBaseUrl).length - 1).toBe(1);
  });

  it('appends only the missing unsubscribe when address is present', () => {
    const body = `Hi.\n\n${config.companyAddress}`;
    const r = ensureFooter(body, config);
    expect(r.added).toBe(true);
    expect(r.hasUnsubscribe).toBe(true);
    expect(r.body).toContain(config.unsubscribeBaseUrl);
  });

  it('handles an empty body', () => {
    const r = ensureFooter('', config);
    expect(r.added).toBe(true);
    expect(r.hasUnsubscribe).toBe(true);
  });
});
