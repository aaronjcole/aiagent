import Link from 'next/link';
import { read } from '../../lib/api';
import { asArray, fmtDate } from '../../lib/format';
import { ApiUnreachable } from '../../components/ApiError';
import type { EmailThread } from '../../lib/types';
import { SimulateInbound } from './SimulateInbound';

export const dynamic = 'force-dynamic';

export default async function InboundPage() {
  const res = await read<unknown>('/threads');
  const threads = res.ok ? asArray<EmailThread>(res.data) : [];

  return (
    <div>
      <h2>Inbound</h2>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Simulate inbound (demo)</h3>
        <p className="muted">
          Posts to <code>/inbound/simulate</code>, which runs classification and may create
          escalations / scheduling — all recorded in the audit log.
        </p>
        <SimulateInbound />
      </div>

      <div className="panel">
        <div className="section-head">
          <h3 style={{ margin: 0 }}>Threads</h3>
        </div>
        {!res.ok ? (
          <ApiUnreachable error={res.error} />
        ) : threads.length === 0 ? (
          <p className="muted">No threads yet. Simulate one above.</p>
        ) : (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Classification</th>
                <th>Requires human</th>
                <th>Messages</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {threads.map((t) => (
                <tr key={t.id}>
                  <td>{t.subject ?? '(no subject)'}</td>
                  <td>{t.classification ? <span className="badge">{t.classification}</span> : '—'}</td>
                  <td>{t.requiresHuman ? <span className="badge">yes</span> : 'no'}</td>
                  <td>{t.messages?.length ?? '—'}</td>
                  <td>{fmtDate(t.createdAt)}</td>
                  <td>
                    <Link href={`/inbound/${t.id}`}>View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
