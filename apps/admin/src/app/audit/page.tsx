import { read } from '../../lib/api';
import { asArray, fmtDate } from '../../lib/format';
import { ApiUnreachable } from '../../components/ApiError';
import type { AuditLog } from '../../lib/types';
import { AuditFilter } from './AuditFilter';

export const dynamic = 'force-dynamic';

interface SearchParams {
  entityType?: string;
  limit?: string;
}

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const entityType = searchParams.entityType ?? '';
  const limit = Number(searchParams.limit ?? '50') || 50;

  const res = await read<unknown>('/audit-logs', {
    entityType: entityType || undefined,
    limit,
  });

  const rawLogs = res.ok ? asArray<AuditLog>(res.data) : null;
  // A null sentinel means the API returned an unexpected shape — treat it like
  // a load failure rather than an empty list.
  const invalidShape = res.ok && rawLogs === null;
  // Newest first (defensive sort in case the API does not guarantee ordering).
  const logs = [...(rawLogs ?? [])].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  return (
    <div>
      <h2>Audit logs</h2>

      <div className="panel">
        <AuditFilter entityType={entityType} limit={limit} />
      </div>

      {!res.ok ? (
        <ApiUnreachable error={res.error} />
      ) : invalidShape ? (
        <ApiUnreachable error="Unexpected response shape from /audit-logs." />
      ) : logs.length === 0 ? (
        <p className="muted">No audit logs{entityType ? ` for entity type “${entityType}”` : ''}.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Entity</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Allowed</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>{fmtDate(log.createdAt)}</td>
                <td>
                  {log.entityType ?? '—'}
                  {log.entityId ? <div className="muted">{log.entityId}</div> : null}
                </td>
                <td>{log.action ?? '—'}</td>
                <td>{log.actor ?? log.actorType ?? '—'}</td>
                <td>
                  {log.allowed === false ? (
                    <span className="badge">blocked</span>
                  ) : log.allowed === true ? (
                    '✓'
                  ) : (
                    '—'
                  )}
                </td>
                <td>{log.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
