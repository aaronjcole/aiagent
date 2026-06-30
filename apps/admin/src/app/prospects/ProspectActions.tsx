'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { client } from '../../lib/client';
import type { OutreachSequence } from '../../lib/types';

export function ProspectRowActions({
  prospectId,
  sequences,
}: {
  prospectId: string;
  sequences: OutreachSequence[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'research' | 'outbound'>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [sequenceId, setSequenceId] = useState<string>(sequences[0]?.id ?? '');

  async function run(action: 'research' | 'outbound') {
    setBusy(action);
    setMsg(null);
    try {
      if (action === 'research') {
        await client.post(`/prospects/${prospectId}/research`);
        setMsg({ kind: 'ok', text: 'Research triggered.' });
      } else {
        if (!sequenceId) {
          setMsg({ kind: 'err', text: 'No sequence selected.' });
          setBusy(null);
          return;
        }
        await client.post('/outbound', { prospectId, sequenceId });
        setMsg({ kind: 'ok', text: 'Outbound started.' });
      }
      router.refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="row-actions">
        <button onClick={() => run('research')} disabled={busy !== null}>
          {busy === 'research' ? 'Running…' : 'Run research'}
        </button>
        {sequences.length > 0 ? (
          <select value={sequenceId} onChange={(e) => setSequenceId(e.target.value)} disabled={busy !== null}>
            {sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? s.id}
              </option>
            ))}
          </select>
        ) : null}
        <button onClick={() => run('outbound')} disabled={busy !== null || sequences.length === 0}>
          {busy === 'outbound' ? 'Starting…' : 'Start outbound'}
        </button>
      </div>
      {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
    </div>
  );
}
