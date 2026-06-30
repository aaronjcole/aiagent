import { describe, it, expect } from 'vitest';
import {
  EmailAutonomyMode,
  CalendarAutonomyMode,
} from '@app/shared';
import {
  canAutoSendOutboundEmail,
  canAutoSendOutboundEmailWithCaps,
  canSendNow,
  canAutoReplyInboundEmail,
  canAutoCreateCalendarEvent,
  canAutoCreateCalendarEventWithCap,
  canBookNow,
  type AutoSendInput,
  type AutoCalendarInput,
  type EmailPolicyDeps,
  type CalendarPolicyDeps,
} from './policy.js';
import { FakeCapRepo, readySettings } from './fakes.js';

// A clock fixed to 2025-06-30 14:00 ET (18:00Z), inside business hours.
const NOW = new Date('2025-06-30T18:00:00.000Z');

function emailDeps(over: Partial<EmailPolicyDeps> = {}): EmailPolicyDeps {
  return {
    settings: readySettings({ emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND }),
    caps: new FakeCapRepo(),
    config: { ENABLE_AUTO_SEND: true },
    now: NOW,
    ...over,
  };
}

function calDeps(over: Partial<CalendarPolicyDeps> = {}): CalendarPolicyDeps {
  return {
    settings: readySettings({
      calendarAutonomyMode: CalendarAutonomyMode.AUTO_BOOK_CONFIRMED,
    }),
    caps: new FakeCapRepo(),
    config: { ENABLE_AUTO_SCHEDULING: true },
    now: NOW,
    ...over,
  };
}

function goodSend(over: Partial<AutoSendInput> = {}): AutoSendInput {
  return {
    senderEmail: 'sender@us.example.com',
    senderActive: true,
    recipientEmail: 'target@acme.com',
    prospectExists: true,
    emailSuppressed: false,
    domainSuppressed: false,
    unsubscribed: false,
    negativeReply: false,
    threadHasSensitiveFlag: false,
    researchStatus: 'researched',
    researchConfidence: 0.9,
    complianceReview: { decision: 'pass', confidence: 0.9 },
    footerPresent: true,
    subject: 'Quick question about your workflow',
    subjectDeceptive: false,
    unsupportedClaims: [],
    prospectId: 'pros_1',
    sequenceId: 'seq_1',
    stepAlreadySent: false,
    prospectSequenceSends: 0,
    alreadySent: false,
    sendAtIso: NOW.toISOString(),
    ...over,
  };
}

function goodCal(over: Partial<AutoCalendarInput> = {}): AutoCalendarInput {
  return {
    fromIsProspect: true,
    classification: { category: 'interested_schedule', confidence: 0.95 },
    explicitSlotAgreement: true,
    timezone: 'America/New_York',
    timezoneAmbiguous: false,
    availabilityCheckedAt: NOW.toISOString(),
    slotStillFree: true,
    // 14:30-15:00 ET (=18:30-19:00Z), 30 min, inside 9-17 ET.
    startIso: '2025-06-30T18:30:00.000Z',
    endIso: '2025-06-30T19:00:00.000Z',
    attendees: ['sender@us.example.com', 'target@acme.com'],
    externalAttendees: ['target@acme.com'],
    threadParticipants: ['target@acme.com', 'sender@us.example.com'],
    sensitiveFlags: [],
    angry: false,
    unsubscribe: false,
    alreadyExists: false,
    ...over,
  };
}

describe('canAutoSendOutboundEmail', () => {
  it('ALLOWS only when every gate passes', () => {
    const d = canAutoSendOutboundEmail(goodSend(), emailDeps());
    expect(d.allow).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  it('denies when ENABLE_AUTO_SEND env flag is off', () => {
    const d = canAutoSendOutboundEmail(
      goodSend(),
      emailDeps({ config: { ENABLE_AUTO_SEND: false } }),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('ENABLE_AUTO_SEND');
  });

  it('denies when autonomy mode is not limited_auto_send', () => {
    const d = canAutoSendOutboundEmail(
      goodSend(),
      emailDeps({
        settings: readySettings({ emailAutonomyMode: EmailAutonomyMode.APPROVAL_REQUIRED }),
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('not limited_auto_send');
  });

  it('denies when email suppressed', () => {
    const d = canAutoSendOutboundEmail(goodSend({ emailSuppressed: true }), emailDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('email is suppressed');
  });

  it('denies when domain suppressed', () => {
    const d = canAutoSendOutboundEmail(goodSend({ domainSuppressed: true }), emailDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('domain is suppressed');
  });

  it('denies when previously unsubscribed', () => {
    const d = canAutoSendOutboundEmail(goodSend({ unsubscribed: true }), emailDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('unsubscribed');
  });

  it('denies when readiness not fully confirmed', () => {
    const d = canAutoSendOutboundEmail(
      goodSend(),
      emailDeps({
        // readySettings turns all readiness on; flip one off via a plain reader.
        settings: readySettings({
          emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND,
          spfDkimDmarcReady: false,
        }),
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('readiness not fully confirmed');
  });

  it('denies on failed compliance review', () => {
    const d = canAutoSendOutboundEmail(
      goodSend({ complianceReview: { decision: 'fail', confidence: 0.99 } }),
      emailDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('compliance review decision is fail');
  });

  it('denies on low compliance confidence', () => {
    const d = canAutoSendOutboundEmail(
      goodSend({ complianceReview: { decision: 'pass', confidence: 0.2 } }),
      emailDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('compliance confidence');
  });

  it('denies on low research confidence', () => {
    const d = canAutoSendOutboundEmail(goodSend({ researchConfidence: 0.1 }), emailDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('research confidence');
  });

  it('denies when subject is deceptive / all-caps', () => {
    const a = canAutoSendOutboundEmail(goodSend({ subjectDeceptive: true }), emailDeps());
    expect(a.allow).toBe(false);
    const b = canAutoSendOutboundEmail(goodSend({ subject: 'BUY NOW FREE MONEY' }), emailDeps());
    expect(b.allow).toBe(false);
    expect(b.reasons.join(' ')).toContain('all-caps');
  });

  it('denies when unsupported claims present', () => {
    const d = canAutoSendOutboundEmail(
      goodSend({ unsupportedClaims: ['we are #1'] }),
      emailDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('unsupported claim');
  });

  it('denies when sender account is inactive', () => {
    const d = canAutoSendOutboundEmail(goodSend({ senderActive: false }), emailDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('not active');
  });

  it('denies when outside business hours', () => {
    // 03:00Z = 23:00 ET previous day, outside 9-17.
    const d = canAutoSendOutboundEmail(
      goodSend({ sendAtIso: '2025-06-30T03:00:00.000Z' }),
      emailDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('business hours');
  });

  it('denies on per-prospect-per-sequence cap', () => {
    const d = canAutoSendOutboundEmail(goodSend({ prospectSequenceSends: 1 }), emailDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('per-prospect-per-sequence');
  });

  it('denies when step already sent', () => {
    const d = canAutoSendOutboundEmail(goodSend({ stepAlreadySent: true }), emailDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('already received this sequence step');
  });

  it('denies on idempotency (alreadySent)', () => {
    const d = canAutoSendOutboundEmail(goodSend({ alreadySent: true }), emailDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('idempotency');
  });

  it('collects MULTIPLE failing reasons (no short-circuit on non-kill-switch gates)', () => {
    const d = canAutoSendOutboundEmail(
      goodSend({ emailSuppressed: true, unsubscribed: true, footerPresent: false }),
      emailDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
  });

  describe('kill switches short-circuit', () => {
    it('global pause', () => {
      const d = canAutoSendOutboundEmail(
        goodSend(),
        emailDeps({
          settings: readySettings({
            emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND,
            globalPauseAllAutomation: true,
          }),
        }),
      );
      expect(d.allow).toBe(false);
      expect(d.reasons).toEqual(['kill switch: globalPauseAllAutomation is on']);
    });

    it('pauseOutboundSending', () => {
      const d = canAutoSendOutboundEmail(
        goodSend(),
        emailDeps({
          settings: readySettings({
            emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND,
            pauseOutboundSending: true,
          }),
        }),
      );
      expect(d.allow).toBe(false);
      expect(d.reasons.join(' ')).toContain('pauseOutboundSending');
    });

    it('paused sender + paused domain', () => {
      const d = canAutoSendOutboundEmail(
        goodSend(),
        emailDeps({
          settings: readySettings({
            emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND,
            pauseSpecificSenderAccounts: ['sender@us.example.com'],
            pauseSpecificDomains: ['acme.com'],
          }),
        }),
      );
      expect(d.allow).toBe(false);
      expect(d.reasons.join(' ')).toContain('is paused');
    });
  });
});

describe('canAutoSendOutboundEmailWithCaps + canSendNow (cap gates)', () => {
  it('denies on global daily cap', async () => {
    const deps = emailDeps({ caps: new FakeCapRepo({ global: 10 }) });
    const d = await canAutoSendOutboundEmailWithCaps(goodSend(), deps);
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('global daily auto-send cap');
  });

  it('denies on per-sender daily cap', async () => {
    const deps = emailDeps({
      caps: new FakeCapRepo({ sender: { 'sender@us.example.com': 10 } }),
    });
    const d = await canAutoSendOutboundEmailWithCaps(goodSend(), deps);
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('per-sender daily auto-send cap');
  });

  it('denies on per-domain daily cap', async () => {
    const deps = emailDeps({ caps: new FakeCapRepo({ domain: { 'acme.com': 2 } }) });
    const d = await canAutoSendOutboundEmailWithCaps(goodSend(), deps);
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('per-domain daily auto-send cap');
  });

  it('denies on min-minutes-between-sends', async () => {
    const recent = new Date(NOW.getTime() - 2 * 60 * 1000); // 2 min ago < 10
    const deps = emailDeps({
      caps: new FakeCapRepo({ lastSenderSendAt: { 'sender@us.example.com': recent } }),
    });
    const d = await canAutoSendOutboundEmailWithCaps(goodSend(), deps);
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('min minutes between sends');
  });

  it('allows when last send is older than the min window', async () => {
    const old = new Date(NOW.getTime() - 30 * 60 * 1000); // 30 min ago
    const deps = emailDeps({
      caps: new FakeCapRepo({ lastSenderSendAt: { 'sender@us.example.com': old } }),
    });
    const d = await canAutoSendOutboundEmailWithCaps(goodSend(), deps);
    expect(d.allow).toBe(true);
  });

  it('canSendNow re-checks time-sensitive gates and allows the clean case', async () => {
    const d = await canSendNow(goodSend(), emailDeps());
    expect(d.allow).toBe(true);
  });

  it('canSendNow denies if kill switch flips on at send time', async () => {
    const deps = emailDeps({
      settings: readySettings({
        emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND,
        pauseOutboundSending: true,
      }),
    });
    const d = await canSendNow(goodSend(), deps);
    expect(d.allow).toBe(false);
  });
});

describe('canAutoReplyInboundEmail', () => {
  it('allows when all gates pass', async () => {
    const d = await canAutoReplyInboundEmail(
      { threadId: 't1', threadHasSensitiveFlag: false, isUnsubscribe: false },
      emailDeps(),
    );
    expect(d.allow).toBe(true);
  });

  it('denies when env flag off', async () => {
    const d = await canAutoReplyInboundEmail(
      { threadId: 't1', threadHasSensitiveFlag: false, isUnsubscribe: false },
      emailDeps({ config: { ENABLE_AUTO_SEND: false } }),
    );
    expect(d.allow).toBe(false);
  });

  it('denies on sensitive flag and on unsubscribe', async () => {
    const a = await canAutoReplyInboundEmail(
      { threadId: 't1', threadHasSensitiveFlag: true, isUnsubscribe: false },
      emailDeps(),
    );
    expect(a.allow).toBe(false);
    const b = await canAutoReplyInboundEmail(
      { threadId: 't1', threadHasSensitiveFlag: false, isUnsubscribe: true },
      emailDeps(),
    );
    expect(b.allow).toBe(false);
  });

  it('denies on per-thread daily reply cap', async () => {
    const deps = emailDeps({ caps: new FakeCapRepo({ threadReplies: { t1: 3 } }) });
    const d = await canAutoReplyInboundEmail(
      { threadId: 't1', threadHasSensitiveFlag: false, isUnsubscribe: false },
      deps,
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('per-thread daily auto-reply cap');
  });

  it('kill switch (pauseInboundReplies) short-circuits', async () => {
    const deps = emailDeps({
      settings: readySettings({
        emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND,
        pauseInboundReplies: true,
      }),
    });
    const d = await canAutoReplyInboundEmail(
      { threadId: 't1', threadHasSensitiveFlag: false, isUnsubscribe: false },
      deps,
    );
    expect(d.allow).toBe(false);
    expect(d.reasons).toEqual(['kill switch: pauseInboundReplies is on']);
  });
});

describe('canAutoCreateCalendarEvent / canBookNow', () => {
  it('ALLOWS when every gate passes', () => {
    const d = canAutoCreateCalendarEvent(goodCal(), calDeps());
    expect(d.allow).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  it('denies when ENABLE_AUTO_SCHEDULING off', () => {
    const d = canAutoCreateCalendarEvent(
      goodCal(),
      calDeps({ config: { ENABLE_AUTO_SCHEDULING: false } }),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('ENABLE_AUTO_SCHEDULING');
  });

  it('denies when autonomy mode not auto_book_confirmed', () => {
    const d = canAutoCreateCalendarEvent(
      goodCal(),
      calDeps({
        settings: readySettings({
          calendarAutonomyMode: CalendarAutonomyMode.PROPOSE_TIMES_ONLY,
        }),
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('not auto_book_confirmed');
  });

  it('denies on invalid timezone', () => {
    const d = canAutoCreateCalendarEvent(goodCal({ timezone: 'Not/AZone' }), calDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('valid IANA');
  });

  it('denies on ambiguous timezone', () => {
    const d = canAutoCreateCalendarEvent(goodCal({ timezoneAmbiguous: true }), calDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('ambiguous');
  });

  it('denies without explicit slot agreement', () => {
    const d = canAutoCreateCalendarEvent(goodCal({ explicitSlotAgreement: false }), calDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('explicit agreement');
  });

  it('denies when slot no longer free', () => {
    const d = canAutoCreateCalendarEvent(goodCal({ slotStillFree: false }), calDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('no longer free');
  });

  it('denies on confidence < 0.90', () => {
    const d = canAutoCreateCalendarEvent(
      goodCal({ classification: { category: 'interested_schedule', confidence: 0.85 } }),
      calDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('classification confidence');
  });

  it('denies on wrong classification category', () => {
    const d = canAutoCreateCalendarEvent(
      goodCal({ classification: { category: 'not_interested', confidence: 0.99 } }),
      calDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('interested_schedule');
  });

  it('denies on legal/pricing/security sensitive flags', () => {
    const d = canAutoCreateCalendarEvent(goodCal({ sensitiveFlags: ['legal'] }), calDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('sensitive flags');
  });

  it('denies when duration out of 15-60', () => {
    const tooLong = canAutoCreateCalendarEvent(
      goodCal({ startIso: '2025-06-30T18:00:00.000Z', endIso: '2025-06-30T19:30:00.000Z' }),
      calDeps(),
    );
    expect(tooLong.allow).toBe(false);
    expect(tooLong.reasons.join(' ')).toContain('out of 15-60');

    const tooShort = canAutoCreateCalendarEvent(
      goodCal({ startIso: '2025-06-30T18:00:00.000Z', endIso: '2025-06-30T18:05:00.000Z' }),
      calDeps(),
    );
    expect(tooShort.allow).toBe(false);
  });

  it('denies when end <= start', () => {
    const d = canAutoCreateCalendarEvent(
      goodCal({ startIso: '2025-06-30T19:00:00.000Z', endIso: '2025-06-30T18:30:00.000Z' }),
      calDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('after start');
  });

  it('denies when outside business hours', () => {
    // 02:00-02:30Z = 22:00 ET, outside 9-17.
    const d = canAutoCreateCalendarEvent(
      goodCal({ startIso: '2025-06-30T02:00:00.000Z', endIso: '2025-06-30T02:30:00.000Z' }),
      calDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('business hours');
  });

  it('denies when external attendee not in thread', () => {
    const d = canAutoCreateCalendarEvent(
      goodCal({
        attendees: ['sender@us.example.com', 'stranger@evil.com'],
        externalAttendees: ['stranger@evil.com'],
      }),
      calDeps(),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('not in thread');
  });

  it('denies when not from prospect', () => {
    const d = canAutoCreateCalendarEvent(goodCal({ fromIsProspect: false }), calDeps());
    expect(d.allow).toBe(false);
  });

  it('denies on idempotency (alreadyExists)', () => {
    const d = canAutoCreateCalendarEvent(goodCal({ alreadyExists: true }), calDeps());
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('idempotency');
  });

  it('kill switch (pauseCalendarCreation) short-circuits', () => {
    const d = canAutoCreateCalendarEvent(
      goodCal(),
      calDeps({
        settings: readySettings({
          calendarAutonomyMode: CalendarAutonomyMode.AUTO_BOOK_CONFIRMED,
          pauseCalendarCreation: true,
        }),
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.reasons).toEqual(['kill switch: pauseCalendarCreation is on']);
  });

  it('canAutoCreateCalendarEventWithCap denies on events/day cap', async () => {
    const deps = calDeps({ caps: new FakeCapRepo({ calendarEvents: 10 }) });
    const d = await canAutoCreateCalendarEventWithCap(goodCal(), deps);
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('daily calendar event cap');
  });

  it('canBookNow allows the clean case and re-checks slot/idempotency/cap', async () => {
    const ok = await canBookNow(goodCal(), calDeps());
    expect(ok.allow).toBe(true);

    const slotGone = await canBookNow(goodCal({ slotStillFree: false }), calDeps());
    expect(slotGone.allow).toBe(false);
  });
});
