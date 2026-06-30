/**
 * Deterministic, LLM-independent opt-out detector.
 *
 * This is a SAFETY-CRITICAL function: it must never miss a clear opt-out. It is
 * intentionally generous — it tolerates rude/informal phrasing, mixed case, and
 * surrounding punctuation/whitespace. The LLM compliance/inbound review runs
 * elsewhere and is *additive*; this regex layer is the guaranteed floor.
 */

export interface UnsubscribeResult {
  isUnsubscribe: boolean;
  /** The canonical phrase label that matched, or null when nothing matched. */
  matchedPhrase: string | null;
}

/**
 * Normalize free text for matching:
 *  - lowercase (case-insensitive matching),
 *  - normalize curly apostrophes to straight,
 *  - collapse any run of non-alphanumeric characters to a single space,
 *  - trim.
 *
 * Collapsing punctuation to spaces makes the patterns tolerant of commas,
 * exclamation points, hyphens, line breaks, and stray symbols (e.g.
 * "STOP!!!", "opt-out", "take me OFF your list, please").
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'") // curly/modifier apostrophes -> '
    .replace(/[^a-z0-9']+/g, ' ') // keep apostrophes (don't/don t both handled below)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Each pattern is documented with the intent it covers. Patterns run against
 * the normalized string. `\b` word boundaries keep matches from firing inside
 * unrelated words. Apostrophes are optional everywhere (don't / dont) because
 * normalization may or may not retain them depending on the source encoding.
 */
interface Pattern {
  /** Canonical label reported as `matchedPhrase`. */
  label: string;
  test: RegExp;
}

const PATTERNS: readonly Pattern[] = [
  // "unsubscribe" / "un subscribe" / "unsubscribe me"
  { label: 'unsubscribe', test: /\bun\s?subscribe\b/ },

  // "opt out" / "opt-out" (hyphen normalizes to a space) / "opt me out"
  { label: 'opt out', test: /\bopt(\s+me)?\s+out\b/ },

  // "remove me" (from your list / from this list / etc.) and bare "remove me"
  { label: 'remove me', test: /\bremove\s+me\b/ },

  // "take me off (your|the|this) list" and lenient "take me off"
  { label: 'take me off your list', test: /\btake\s+me\s+off\b/ },

  // "stop emailing" / "stop emailing me" / "stop sending (me) emails" /
  // "stop contacting me" / "stop messaging me"
  {
    label: 'stop emailing',
    test: /\bstop\s+(emailing|e\s?mailing|sending|contacting|messaging|texting)\b/,
  },

  // "do not contact me" / "don't contact me" / "do not email me" / "dont email me"
  {
    label: 'do not contact me',
    test: /\b(do\s+not|don'?t)\s+(contact|email|e\s?mail|message|reach\s+out)\b/,
  },

  // "not interested" combined with a "stop" command — "not interested stop",
  // "not interested, stop emailing", "not interested please stop".
  {
    label: 'not interested stop',
    test: /\bnot\s+interested\b[\s\S]*\bstop\b/,
  },

  // "leave me alone"
  { label: 'leave me alone', test: /\bleave\s+me\s+alone\b/ },

  // Rude / informal opt-outs that are unambiguous in intent.
  { label: 'go away', test: /\b(go\s+away|piss\s+off|fuck\s+off|f\s*off|buzz\s+off)\b/ },

  // "no more emails" / "no more messages" / "stop the emails"
  { label: 'no more emails', test: /\bno\s+more\s+(emails?|messages?|mails?)\b/ },
];

/**
 * A bare "stop" standing as a command. We accept it when:
 *  - the entire (normalized) message is just "stop" (carrier-style STOP keyword),
 *  - or "stop" appears as a leading/standalone command ("stop." / "stop please" /
 *    "please stop"), but NOT when it's part of a larger benign phrase such as
 *    "please stop by our booth" or "don't stop believing".
 *
 * Strategy: match "stop" only when it is not immediately followed by a word that
 * turns it into a different meaning ("stop by", "stop in", "stopping"), and is a
 * standalone token. Short messages dominated by "stop" are treated as opt-outs.
 */
const STOP_FOLLOWERS_BENIGN = /^(by|in|over|believing|believin|sign)\b/;

function matchesBareStop(normalized: string): boolean {
  // Whole message is exactly "stop".
  if (normalized === 'stop') return true;

  // Find every standalone "stop" token and inspect what follows it.
  const re = /\bstop\b\s*(.*)$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const rest = (m[1] ?? '').trim();
    // "stop by", "stop in", "stop believing" -> benign, keep scanning.
    if (rest.length > 0 && STOP_FOLLOWERS_BENIGN.test(rest)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Detect an opt-out / unsubscribe request in arbitrary inbound text.
 *
 * Case-insensitive, punctuation- and whitespace-tolerant. Returns the canonical
 * matched phrase for auditing.
 */
export function classifyUnsubscribe(text: string): UnsubscribeResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { isUnsubscribe: false, matchedPhrase: null };
  }

  const normalized = normalize(text);

  for (const pattern of PATTERNS) {
    if (pattern.test.test(normalized)) {
      return { isUnsubscribe: true, matchedPhrase: pattern.label };
    }
  }

  if (matchesBareStop(normalized)) {
    return { isUnsubscribe: true, matchedPhrase: 'stop' };
  }

  return { isUnsubscribe: false, matchedPhrase: null };
}
