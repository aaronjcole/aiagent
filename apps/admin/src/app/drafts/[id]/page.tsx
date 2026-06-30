import Link from 'next/link';
import { read } from '../../../lib/api';
import { fmtDate } from '../../../lib/format';
import { ApiUnreachable } from '../../../components/ApiError';
import type { DraftEmail } from '../../../lib/types';

/** Always render at request time so the draft detail reflects live API data. */
export const dynamic = 'force-dynamic';

/** Draft detail page: shows one draft's metadata, body, and compliance flags. */
export default async function DraftDetailPage({ params }: { params: { id: string } }) {
  const res = await read<DraftEmail>(`/drafts/${params.id}`);

  if (!res.ok) {
    return (
      <div>
        <h2>Draft</h2>
        <ApiUnreachable error={res.error} />
      </div>
    );
  }

  const d = res.data;

  return (
    <div>
      <p>
        <Link href="/drafts">← Drafts</Link>
      </p>
      <h2>{d.subject ?? '(no subject)'}</h2>

      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>Status</th>
              <td>
                <span className="badge">{d.status}</span>
              </td>
            </tr>
            <tr>
              <th>To</th>
              <td>{d.toEmail ?? '—'}</td>
            </tr>
            <tr>
              <th>From</th>
              <td>{d.fromEmail ?? '—'}</td>
            </tr>
            <tr>
              <th>Prospect</th>
              <td>{d.prospectId ? <Link href={`/prospects/${d.prospectId}`}>{d.prospectId}</Link> : '—'}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{fmtDate(d.createdAt)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Body</h3>
        <pre className="body">{d.bodyText ?? d.body ?? '(no body)'}</pre>
      </div>

      {d.complianceFlags ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Compliance flags</h3>
          <pre className="body">{JSON.stringify(d.complianceFlags, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}
