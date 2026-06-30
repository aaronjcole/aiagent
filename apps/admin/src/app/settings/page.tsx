import { read } from '../../lib/api';
import { asArray, fmtDate } from '../../lib/format';
import { ApiUnreachable } from '../../components/ApiError';
import type { SystemSetting, Json } from '../../lib/types';
import { AutoSendToggle } from './AutoSendToggle';

/** Always render at request time so settings reflect live API data. */
export const dynamic = 'force-dynamic';

const AUTO_SEND_KEY = 'auto_send_enabled';

/** Coerce a JSON setting value (bool/string/number/wrapped) to a boolean. */
function isTruthy(value: Json | undefined): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
  if (typeof value === 'number') return value === 1;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = (value as Record<string, Json>).value;
    return isTruthy(inner);
  }
  return false;
}

/** Render a JSON setting value as a display string. */
function renderValue(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Settings page: auto-send toggle plus a table of all system settings. */
export default async function SettingsPage() {
  const res = await read<unknown>('/settings');

  if (!res.ok) {
    return (
      <div>
        <h2>Settings</h2>
        <ApiUnreachable error={res.error} />
      </div>
    );
  }

  const settings = asArray<SystemSetting>(res.data) ?? [];
  const autoSend = settings.find((s) => s.key === AUTO_SEND_KEY);
  const autoSendOn = isTruthy(autoSend?.value);

  return (
    <div>
      <h2>System settings</h2>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Auto-send</h3>
        <div className="note">
          <strong>Auto-send ALSO requires the <code>AUTO_SEND_ENABLED</code> env flag.</strong> This
          toggle only flips the <code>{AUTO_SEND_KEY}</code> system setting. The send pipeline gates
          on BOTH the env flag and this setting; <code>SENDING_ENABLED</code> must also be on.
          Default is OFF (safe — drafts only).
        </div>
        <div style={{ marginTop: 12 }}>
          <AutoSendToggle initialValue={autoSendOn} />
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>All settings</h3>
        {settings.length === 0 ? (
          <p className="muted">No settings returned by the API.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Description</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {settings.map((s) => (
                <tr key={s.key}>
                  <td>
                    <code>{s.key}</code>
                  </td>
                  <td>{renderValue(s.value)}</td>
                  <td>{s.description ?? '—'}</td>
                  <td>{fmtDate(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
