'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { client } from '../../lib/client';

/** Form that posts a simulated inbound email to /inbound/simulate (demo tooling). */
export function SimulateInbound() {
  const router = useRouter();
  const [from, setFrom] = useState('prospect@example.com');
  const [subject, setSubject] = useState('Re: quick question');
  const [body, setBody] = useState('Sounds good — can we meet next Tuesday at 2pm ET?');
  const [threadId, setThreadId] = useState('');
  const [providerMessageId, setProviderMessageId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await client.post('/inbound/simulate', {
        from,
        subject,
        body,
        threadId: threadId || undefined,
        providerMessageId: providerMessageId || undefined,
      });
      setMsg({ kind: 'ok', text: 'Inbound message simulated.' });
      router.refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="inline">
        <div className="field">
          <label htmlFor="si-from">From *</label>
          <input id="si-from" type="email" required value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 240 }}>
          <label htmlFor="si-subject">Subject</label>
          <input id="si-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="si-thread">Thread ID (optional)</label>
          <input id="si-thread" value={threadId} onChange={(e) => setThreadId(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="si-pmid">Provider message ID (optional)</label>
          <input
            id="si-pmid"
            value={providerMessageId}
            onChange={(e) => setProviderMessageId(e.target.value)}
          />
        </div>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label htmlFor="si-body">Body</label>
        <textarea id="si-body" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Simulating…' : 'Simulate inbound'}
        </button>
      </div>
      {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
    </form>
  );
}
