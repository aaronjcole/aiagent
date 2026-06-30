'use client';

/**
 * "Send now (if policy allows)" action for an OUTREACH_SEND approval item.
 * POSTs `/drafts/:id/send` through the proxy and surfaces the result: sent on
 * success, or blocked + the policy denial reasons the API returns on failure.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { client } from '../../lib/client';
import type { Json } from '../../lib/types';

/** Extract human-readable denial reasons from an arbitrary API error/response body. */
function extractReasons(body: Json | undefined): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const obj = body as Record<string, Json>;
  const raw = obj.denialReasons ?? obj.reasons;
  if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === 'string');
  if (typeof obj.reason === 'string') return [obj.reason];
  return [];
}

/** Button that requests an immediate policy-gated send of an approved draft, surfacing denial reasons. */
export function SendNowAction({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; reasons?: string[] } | null>(
    null,
  );

  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await client.post<Json>(`/drafts/${draftId}/send`, {});
      // The API may report a soft block in the 2xx body (sent: false + reasons).
      if (res && typeof res === 'object' && !Array.isArray(res) && (res as Record<string, Json>).sent === false) {
        setMsg({ kind: 'err', text: 'Blocked by policy.', reasons: extractReasons(res) });
      } else {
        setMsg({ kind: 'ok', text: 'Sent.' });
      }
      router.refresh();
    } catch (err) {
      // The proxy/client throws with the upstream error text; show it plus any
      // structured reasons we can recover from a JSON message.
      const text = err instanceof Error ? err.message : 'Send failed';
      let reasons: string[] = [];
      try {
        reasons = extractReasons(JSON.parse(text) as Json);
      } catch {
        /* not JSON — keep the plain message */
      }
      setMsg({ kind: 'err', text: reasons.length ? 'Blocked by policy.' : text, reasons });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button className="primary" onClick={send} disabled={busy}>
        {busy ? 'Sending…' : 'Send now (if policy allows)'}
      </button>
      {msg ? (
        <div className={`msg ${msg.kind}`}>
          {msg.text}
          {msg.reasons && msg.reasons.length ? (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {msg.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
