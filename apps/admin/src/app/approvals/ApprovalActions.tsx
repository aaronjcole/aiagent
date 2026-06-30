'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { client } from '../../lib/client';

export function ApprovalActions({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function act(decision: 'approve' | 'reject') {
    setBusy(decision);
    setMsg(null);
    try {
      await client.post(`/approvals/${approvalId}/${decision}`, {
        reason: reason || undefined,
        actor: 'admin-ui',
      });
      setMsg({ kind: 'ok', text: decision === 'approve' ? 'Approved.' : 'Rejected.' });
      router.refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="field" style={{ marginBottom: 8 }}>
        <label htmlFor={`reason-${approvalId}`}>Reason (optional)</label>
        <input
          id={`reason-${approvalId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="why?"
        />
      </div>
      <div className="row-actions">
        <button className="ok" onClick={() => act('approve')} disabled={busy !== null}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button className="danger" onClick={() => act('reject')} disabled={busy !== null}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
    </div>
  );
}
