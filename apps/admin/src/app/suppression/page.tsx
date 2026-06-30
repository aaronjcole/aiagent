import { read } from '../../lib/api';
import { asArray, fmtDate } from '../../lib/format';
import { ApiUnreachable } from '../../components/ApiError';
import type { SuppressionEntry } from '../../lib/types';
import { AddSuppression, DeleteSuppression } from './SuppressionActions';

export const dynamic = 'force-dynamic';

export default async function SuppressionPage() {
  const res = await read<unknown>('/suppression');
  const entries = res.ok ? asArray<SuppressionEntry>(res.data) : [];

  return (
    <div>
      <h2>Suppression list</h2>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Add entry</h3>
        <p className="muted">
          Adding or removing an entry calls the API, which records the change in the audit log and
          enforces it in the outbound safety gate.
        </p>
        <AddSuppression />
      </div>

      {!res.ok ? (
        <ApiUnreachable error={res.error} />
      ) : entries.length === 0 ? (
        <p className="muted">No suppression entries.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Domain</th>
              <th>Reason</th>
              <th>Notes</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{e.email ?? '—'}</td>
                <td>{e.domain ?? '—'}</td>
                <td>{e.reason ? <span className="badge">{e.reason}</span> : '—'}</td>
                <td>{e.notes ?? '—'}</td>
                <td>{fmtDate(e.createdAt)}</td>
                <td>
                  <DeleteSuppression id={e.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
