'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { client } from '../../lib/client';

const REASONS = ['unsubscribe', 'bounce', 'complaint', 'manual', 'global_block', 'competitor'] as const;

export function AddSuppression() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [domain, setDomain] = useState('');
  const [reason, setReason] = useState<string>('manual');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email && !domain) {
      setMsg({ kind: 'err', text: 'Provide an email or a domain.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await client.post('/suppression', {
        email: email || undefined,
        domain: domain || undefined,
        reason,
        notes: notes || undefined,
      });
      setMsg({ kind: 'ok', text: 'Suppression entry added.' });
      setEmail('');
      setDomain('');
      setNotes('');
      router.refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline" onSubmit={submit}>
      <div className="field">
        <label htmlFor="su-email">Email</label>
        <input id="su-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="su-domain">Domain</label>
        <input id="su-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" />
      </div>
      <div className="field">
        <label htmlFor="su-reason">Reason</label>
        <select id="su-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="field" style={{ flex: 1, minWidth: 200 }}>
        <label htmlFor="su-notes">Notes</label>
        <input id="su-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Adding…' : 'Add'}
      </button>
      {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
    </form>
  );
}

export function DeleteSuppression({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      await client.del(`/suppression/${id}`);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="danger" onClick={remove} disabled={busy}>
        {busy ? 'Removing…' : 'Remove'}
      </button>
      {err ? <div className="msg err">{err}</div> : null}
    </div>
  );
}
