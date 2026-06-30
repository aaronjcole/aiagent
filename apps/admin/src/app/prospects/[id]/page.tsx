import Link from 'next/link';
import { read } from '../../../lib/api';
import { asArray, prospectName, fmtDate, fmtConfidence } from '../../../lib/format';
import { ApiUnreachable, ApiSideWarning } from '../../../components/ApiError';
import type { Prospect, ResearchResult, OutreachSequence } from '../../../lib/types';
import { ProspectRowActions } from '../ProspectActions';

export const dynamic = 'force-dynamic';

export default async function ProspectDetailPage({ params }: { params: { id: string } }) {
  const [prospectRes, researchRes, sequencesRes] = await Promise.all([
    read<Prospect>(`/prospects/${params.id}`),
    read<unknown>('/research', { prospectId: params.id }),
    read<unknown>('/sequences'),
  ]);

  if (!prospectRes.ok) {
    return (
      <div>
        <h2>Prospect</h2>
        <ApiUnreachable error={prospectRes.error} />
      </div>
    );
  }

  const p = prospectRes.data;
  const research = researchRes.ok ? asArray<ResearchResult>(researchRes.data) : null;
  const sequences = sequencesRes.ok ? asArray<OutreachSequence>(sequencesRes.data) : null;

  // Surface side-query failures (don't make them look like "no data").
  const researchError = !researchRes.ok
    ? researchRes.error
    : research === null
      ? 'Unexpected response shape.'
      : null;
  const sequencesError = !sequencesRes.ok
    ? sequencesRes.error
    : sequences === null
      ? 'Unexpected response shape.'
      : null;

  return (
    <div>
      <p>
        <Link href="/prospects">← Prospects</Link>
      </p>
      <h2>{prospectName(p)}</h2>

      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>Email</th>
              <td>{p.email}</td>
            </tr>
            <tr>
              <th>Title</th>
              <td>{p.title ?? '—'}</td>
            </tr>
            <tr>
              <th>Company</th>
              <td>{p.companyName ?? p.companyDomain ?? '—'}</td>
            </tr>
            <tr>
              <th>Status</th>
              <td>
                <span className="badge">{p.status}</span>
              </td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{fmtDate(p.createdAt)}</td>
            </tr>
          </tbody>
        </table>
        {sequencesError ? <ApiSideWarning label="sequences" error={sequencesError} /> : null}
        <div style={{ marginTop: 12 }}>
          <ProspectRowActions prospectId={p.id} sequences={sequences ?? []} />
        </div>
      </div>

      <div className="panel">
        <div className="section-head">
          <h3 style={{ margin: 0 }}>Research</h3>
          <Link href="/research">All research →</Link>
        </div>
        {researchError ? (
          <ApiSideWarning label="research" error={researchError} />
        ) : research === null || research.length === 0 ? (
          <p className="muted">No research yet. Use “Run research” above.</p>
        ) : (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Confidence</th>
                <th>Summary</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {research.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="badge">{r.status}</span>
                  </td>
                  <td>{fmtConfidence(r.confidence ?? r.output?.confidence)}</td>
                  <td>{r.summary ?? r.output?.summary ?? '—'}</td>
                  <td>{fmtDate(r.createdAt)}</td>
                  <td>
                    <Link href={`/research/${r.id}`}>View</Link>
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
