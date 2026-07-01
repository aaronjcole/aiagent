import Link from 'next/link';
import { read } from '../../lib/api';
import { asArray, fmtDate } from '../../lib/format';
import { ApiUnreachable } from '../../components/ApiError';
import type { DraftEmail } from '../../lib/types';
import { DraftStatusFilter } from './DraftStatusFilter';

/** Always render at request time so the drafts list reflects live API data. */
export const dynamic = 'force-dynamic';

/** Drafts page: lists draft emails in a table, filterable by status. */
export default async function DraftsPage({ searchParams }: { searchParams: { status?: string } }) {
  const status = searchParams.status ?? '';
  const res = await read<unknown>('/drafts', { status: status || undefined });
  const drafts = res.ok ? asArray<DraftEmail>(res.data) : null;
  const invalidShape = res.ok && drafts === null;

  return (
    <div>
      <h2>Drafts</h2>

      <div className="panel">
        <DraftStatusFilter status={status} />
      </div>

      {!res.ok ? (
        <ApiUnreachable error={res.error} />
      ) : invalidShape || drafts === null ? (
        <ApiUnreachable error="Unexpected response shape from /drafts." />
      ) : drafts.length === 0 ? (
        <p className="muted">No drafts{status ? ` with status “${status}”` : ''}.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Subject</th>
              <th>To</th>
              <th>Status</th>
              <th>Prospect</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => (
              <tr key={d.id}>
                <td>{d.subject ?? '—'}</td>
                <td>{d.toEmail ?? '—'}</td>
                <td>
                  <span className="badge">{d.status}</span>
                </td>
                <td>
                  {d.prospectId ? <Link href={`/prospects/${d.prospectId}`}>{d.prospectId}</Link> : '—'}
                </td>
                <td>{fmtDate(d.createdAt)}</td>
                <td>
                  <Link href={`/drafts/${d.id}`}>View</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
