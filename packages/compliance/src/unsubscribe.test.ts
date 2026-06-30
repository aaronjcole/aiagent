/** Tests for {@link classifyUnsubscribe}: deterministic opt-out detection. */
import { describe, it, expect } from 'vitest';
import { classifyUnsubscribe } from './unsubscribe.js';

describe('classifyUnsubscribe', () => {
  const optOuts: string[] = [
    'unsubscribe',
    'Please UNSUBSCRIBE me from this list.',
    'remove me',
    'Remove me from your mailing list immediately',
    'take me off your list',
    'TAKE ME OFF this list, thanks',
    'stop emailing',
    'stop emailing me',
    'Please stop sending me emails',
    'do not contact me',
    "don't contact me",
    "Don't email me again",
    'not interested stop',
    'Not interested. Stop emailing me.',
    'opt out',
    'opt-out',
    'I want to opt out of these messages',
    'leave me alone',
    'STOP',
    'stop.',
    'please stop',
    'go away',
    'ugh, f off and stop emailing me', // rude / informal
    'no more emails please',
  ];

  it.each(optOuts)('detects opt-out: %s', (text) => {
    const result = classifyUnsubscribe(text);
    expect(result.isUnsubscribe).toBe(true);
    expect(result.matchedPhrase).not.toBeNull();
  });

  const nonOptOuts: string[] = [
    'Please stop by our booth at the conference next week!',
    "I'm very interested, can we set up a call?",
    'Thanks for reaching out, this looks great.',
    "Don't stop believing — loved the newsletter.",
    'We should hop on a call to discuss pricing.',
    'Could you send me more information about the product?',
    '',
    '   ',
  ];

  it.each(nonOptOuts)('does NOT misclassify: %s', (text) => {
    const result = classifyUnsubscribe(text);
    expect(result.isUnsubscribe).toBe(false);
    expect(result.matchedPhrase).toBeNull();
  });

  it('reports the matched phrase label', () => {
    expect(classifyUnsubscribe('UNSUBSCRIBE now').matchedPhrase).toBe('unsubscribe');
    expect(classifyUnsubscribe('opt-out').matchedPhrase).toBe('opt out');
    expect(classifyUnsubscribe('STOP').matchedPhrase).toBe('stop');
  });

  it('detects an opt-out present only in the subject line', () => {
    const result = classifyUnsubscribe({
      subject: 'Please UNSUBSCRIBE me',
      body: 'Thanks for the info, looks great.',
    });
    expect(result.isUnsubscribe).toBe(true);
    expect(result.matchedPhrase).toBe('unsubscribe');
  });

  it('does NOT flag a benign subject + benign body', () => {
    const result = classifyUnsubscribe({
      subject: 'Re: pricing question',
      body: "I'm very interested, can we set up a call?",
    });
    expect(result.isUnsubscribe).toBe(false);
    expect(result.matchedPhrase).toBeNull();
  });

  it('treats a plain string as the body (backward-compatible)', () => {
    expect(classifyUnsubscribe('unsubscribe').isUnsubscribe).toBe(true);
    expect(classifyUnsubscribe('Thanks for reaching out').isUnsubscribe).toBe(false);
  });

  it('detects an opt-out in the body when subject is omitted on the object form', () => {
    const result = classifyUnsubscribe({ body: 'stop emailing me' });
    expect(result.isUnsubscribe).toBe(true);
  });
});
