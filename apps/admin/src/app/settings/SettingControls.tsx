'use client';

/**
 * Client-side editors for individual `SystemSetting` keys. Each control PUTs to
 * `/settings/:key` with `{ value }` through the same-origin proxy and refreshes
 * the page so server-rendered sections reflect the new value. All show inline
 * success/error feedback and degrade to an error message on a 400/unreachable.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { client } from '../../lib/client';

type Msg = { kind: 'ok' | 'err'; text: string } | null;

/** PUT a single setting value, returning the resulting feedback message. */
async function putSetting(key: string, value: unknown): Promise<void> {
  await client.put(`/settings/${key}`, { value });
}

/** A labeled <select> for an enum-valued setting (autonomy modes). */
export function SelectSetting({
  settingKey,
  label,
  value,
  options,
  defaultValue,
  note,
}: {
  settingKey: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  defaultValue: string;
  note?: React.ReactNode;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(value);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function onChange(next: string) {
    const prev = current;
    setCurrent(next);
    setBusy(true);
    setMsg(null);
    try {
      await putSetting(settingKey, next);
      setMsg({ kind: 'ok', text: `${settingKey} set to ${next}.` });
      router.refresh();
    } catch (err) {
      setCurrent(prev);
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field" style={{ marginBottom: 12 }}>
      <label htmlFor={`set-${settingKey}`}>
        {label} <code>{settingKey}</code>
      </label>
      <select
        id={`set-${settingKey}`}
        value={current}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        style={{ maxWidth: 420 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {o.value === defaultValue ? ' (safe default)' : ''}
          </option>
        ))}
      </select>
      {note ? <div className="muted msg">{note}</div> : null}
      {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
    </div>
  );
}

/** Inline number/text editor with a Save button for a single setting key. */
export function ValueSetting({
  settingKey,
  label,
  value,
  kind,
  unit,
  help,
}: {
  settingKey: string;
  label: string;
  value: string;
  kind: 'int' | 'float' | 'text';
  unit?: string;
  help?: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const dirty = draft !== value;

  async function save() {
    setBusy(true);
    setMsg(null);
    let payload: unknown = draft;
    if (kind === 'int' || kind === 'float') {
      const n = Number(draft);
      if (!Number.isFinite(n) || draft.trim() === '') {
        setBusy(false);
        setMsg({ kind: 'err', text: 'Enter a valid number.' });
        return;
      }
      payload = n;
    }
    try {
      await putSetting(settingKey, payload);
      setMsg({ kind: 'ok', text: 'Saved.' });
      router.refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <div>{label}</div>
        <code className="muted">{settingKey}</code>
        {help ? <div className="muted" style={{ fontSize: 11 }}>{help}</div> : null}
      </td>
      <td>
        <div className="row-actions" style={{ alignItems: 'center' }}>
          <input
            type={kind === 'text' ? 'text' : 'number'}
            step={kind === 'float' ? 'any' : 1}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            style={{ width: kind === 'text' ? 200 : 120 }}
          />
          {unit ? <span className="muted">{unit}</span> : null}
          <button className="primary" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
        {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
      </td>
    </tr>
  );
}

/** A toggle for a boolean setting. `prominent` styles the global pause loudly. */
export function ToggleSetting({
  settingKey,
  label,
  value,
  help,
  prominent = false,
}: {
  settingKey: string;
  label: string;
  value: boolean;
  help?: string;
  prominent?: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(value);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setMsg(null);
    try {
      await putSetting(settingKey, next);
      setOn(next);
      setMsg({ kind: 'ok', text: `${settingKey} set to ${next}.` });
      router.refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  const activeClass = prominent ? 'danger' : 'ok';

  return (
    <div
      style={{
        padding: prominent ? '12px 14px' : '6px 0',
        border: prominent ? '1px solid #fecaca' : undefined,
        background: prominent ? '#fef2f2' : undefined,
        borderRadius: prominent ? 8 : undefined,
        marginBottom: 8,
      }}
    >
      <div className="row-actions" style={{ alignItems: 'center' }}>
        <span className="badge">{on ? 'ON' : 'OFF'}</span>
        <strong style={prominent ? { color: '#991b1b' } : undefined}>{label}</strong>
        <code className="muted">{settingKey}</code>
        <button className={on ? activeClass : ''} onClick={toggle} disabled={busy}>
          {busy ? 'Saving…' : on ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      {help ? <div className="muted msg">{help}</div> : null}
      {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
    </div>
  );
}

/** Comma-list editor for a string[] setting (sender accounts / domains). */
export function ListSetting({
  settingKey,
  label,
  value,
  placeholder,
}: {
  settingKey: string;
  label: string;
  value: string[];
  placeholder: string;
}) {
  const router = useRouter();
  const joined = value.join(', ');
  const [draft, setDraft] = useState(joined);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const dirty = draft !== joined;

  async function save() {
    setBusy(true);
    setMsg(null);
    const list = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await putSetting(settingKey, list);
      setMsg({ kind: 'ok', text: `Saved ${list.length} entr${list.length === 1 ? 'y' : 'ies'}.` });
      router.refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field" style={{ marginBottom: 12 }}>
      <label htmlFor={`list-${settingKey}`}>
        {label} <code>{settingKey}</code> <span className="muted">(comma-separated)</span>
      </label>
      <div className="row-actions" style={{ alignItems: 'center' }}>
        <input
          id={`list-${settingKey}`}
          value={draft}
          disabled={busy}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: 360 }}
        />
        <button className="primary" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
    </div>
  );
}
