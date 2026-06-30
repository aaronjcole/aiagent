import Link from 'next/link';
import { read } from '../lib/api';
import { asArray, fmtDate } from '../lib/format';
import { ApiUnreachable } from '../components/ApiError';
import type { AuditLog, Prospect, ApprovalItem, DraftEmail, SuppressionEntry } from '../lib/types';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [prospects, approvals, drafts, suppression, audit] = await Promise.all([
    read<unknown>('/prospects'),
    read<unknown>('/approvals', { status: 'pending' }),
    read<unknown>('/drafts'),
    read<unknown>('/suppression'),
    read<unknown>('/audit-logs', { limit: 5 }),
  ]);

  const anyFailed = [prospects, approvals, drafts, suppression, audit].find((r) => !r.ok);

  const cards: ReadonlyArray<{ label: string; href: string; count: number | null }> = [
    { label: 'Prospects', href: '/prospects', count: prospects.ok ? asArray<Prospect>(prospects.data).length : null },
    {
      label: 'Pending approvals',
      href: '/approvals',
      count: approvals.ok ? asArray<ApprovalItem>(approvals.data).length : null,
    },
    { label: 'Drafts', href: '/drafts', count: drafts.ok ? asArray<DraftEmail>(drafts.data).length : null },
    {
      label: 'Suppression entries',
      href: '/suppression',
      count: suppression.ok ? asArray<SuppressionEntry>(suppression.data).length : null,
    },
  ];

  const recentLogs = audit.ok ? asArray<AuditLog>(audit.data).slice(0, 5) : [];

  return (
    <div>
      <h2>Dashboard</h2>
      {anyFailed && !anyFailed.ok ? <ApiUnreachable error={anyFailed.error} /> : null}

      <div className="cards" style={{ marginTop: 16 }}>
        {cards.map((c) => (
          <Link key={c.label} href={c.href} className="card" style={{ display: 'block' }}>
            <div className="num">{c.count === null ? '—' : c.count}</div>
            <div className="label">{c.label}</div>
          </Link>
        ))}
      </div>

      <div className="panel" style={{ marginTop: 24 }}>
        <div className="section-head">
          <h3 style={{ margin: 0 }}>Recent audit logs</h3>
          <Link href="/audit">View all →</Link>
        </div>
        {recentLogs.length === 0 ? (
          <p className="muted">No recent audit logs.</p>
        ) : (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>When</th>
                <th>Entity</th>
                <th>Action</th>
                <th>Allowed</th>
              </tr>
            </thead>
            <tbody>
              {recentLogs.map((log) => (
                <tr key={log.id}>
                  <td>{fmtDate(log.createdAt)}</td>
                  <td>
                    {log.entityType ?? '—'}
                    {log.entityId ? <span className="muted"> · {log.entityId}</span> : null}
                  </td>
                  <td>{log.action ?? '—'}</td>
                  <td>{log.allowed === false ? <span className="badge">blocked</span> : '✓'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
