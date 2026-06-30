import Link from 'next/link';
import { read } from '../../lib/api';
import { asArray, fmtConfidence, fmtDate } from '../../lib/format';
import { ApiUnreachable } from '../../components/ApiError';
import type { ResearchResult } from '../../lib/types';

/** Always render at request time so the research list reflects live API data. */
export const dynamic = 'force-dynamic';

/** Research page: lists all research results in a table. */
export default async function ResearchPage() {
  const res = await read<unknown>('/research');

  if (!res.ok) {
    return (
      <div>
        <h2>Research</h2>
        <ApiUnreachable error={res.error} />
      </div>
    );
  }

  const results = asArray<ResearchResult>(res.data);

  if (results === null) {
    return (
      <div>
        <h2>Research</h2>
        <ApiUnreachable error="Unexpected response shape from /research." />
      </div>
    );
  }

  return (
    <div>
      <h2>Research results</h2>
      {results.length === 0 ? (
        <p className="muted">No research results yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Prospect</th>
              <th>Status</th>
              <th>Confidence</th>
              <th>Sources</th>
              <th>Summary</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const sources = r.output?.sources?.length ?? 0;
              return (
                <tr key={r.id}>
                  <td>
                    {r.prospectId ? (
                      <Link href={`/prospects/${r.prospectId}`}>{r.prospectId}</Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className="badge">{r.status}</span>
                  </td>
                  <td>{fmtConfidence(r.confidence ?? r.output?.confidence)}</td>
                  <td>{sources}</td>
                  <td>{r.summary ?? r.output?.summary ?? '—'}</td>
                  <td>{fmtDate(r.createdAt)}</td>
                  <td>
                    <Link href={`/research/${r.id}`}>View</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
