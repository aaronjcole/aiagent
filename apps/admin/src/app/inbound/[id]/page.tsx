import Link from 'next/link';
import { read } from '../../../lib/api';
import { asArray, fmtDate } from '../../../lib/format';
import { ApiUnreachable } from '../../../components/ApiError';
import type { EmailThread, EmailMessage } from '../../../lib/types';

/** Always render at request time so the thread detail reflects live API data. */
export const dynamic = 'force-dynamic';

/** Thread detail page: shows an email thread's metadata and its messages. */
export default async function ThreadDetailPage({ params }: { params: { id: string } }) {
  const res = await read<EmailThread>(`/threads/${params.id}`);

  if (!res.ok) {
    return (
      <div>
        <h2>Thread</h2>
        <ApiUnreachable error={res.error} />
      </div>
    );
  }

  const t = res.data;
  const messages = asArray<EmailMessage>(t.messages ?? []) ?? [];

  return (
    <div>
      <p>
        <Link href="/inbound">← Inbound</Link>
      </p>
      <h2>{t.subject ?? '(no subject)'}</h2>

      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>Classification</th>
              <td>{t.classification ? <span className="badge">{t.classification}</span> : '—'}</td>
            </tr>
            <tr>
              <th>Requires human</th>
              <td>{t.requiresHuman ? 'yes' : 'no'}</td>
            </tr>
            <tr>
              <th>Prospect</th>
              <td>{t.prospectId ? <Link href={`/prospects/${t.prospectId}`}>{t.prospectId}</Link> : '—'}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{fmtDate(t.createdAt)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Messages</h3>
        {messages.length === 0 ? (
          <p className="muted">No messages on this thread.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 10 }}>
              <div>
                <span className="badge">{m.direction}</span>{' '}
                <strong>{m.subject ?? '(no subject)'}</strong>
              </div>
              <div className="muted">
                {m.fromEmail ?? '—'} → {m.toEmail ?? '—'} · {fmtDate(m.receivedAt ?? m.createdAt)}
              </div>
              <pre className="body">{m.bodyText ?? '(no body)'}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
