'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { client } from '../../lib/client';

/** Toggle button that flips the `auto_send_enabled` system setting via the API. */
export function AutoSendToggle({ initialValue }: { initialValue: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function toggle() {
    const next = !enabled;
    setBusy(true);
    setMsg(null);
    try {
      await client.put('/settings/auto_send_enabled', { value: next });
      setEnabled(next);
      setMsg({ kind: 'ok', text: `auto_send_enabled set to ${next}.` });
      router.refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row-actions" style={{ alignItems: 'center' }}>
        <span className="badge">{enabled ? 'ON' : 'OFF'}</span>
        <button className={enabled ? 'danger' : 'ok'} onClick={toggle} disabled={busy}>
          {busy ? 'Saving…' : enabled ? 'Disable auto-send' : 'Enable auto-send'}
        </button>
      </div>
      {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
    </div>
  );
}
