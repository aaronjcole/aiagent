import Link from 'next/link';
import { read } from '../../../lib/api';
import { fmtConfidence, fmtDate } from '../../../lib/format';
import { ApiUnreachable } from '../../../components/ApiError';
import type { ResearchResult } from '../../../lib/types';

export const dynamic = 'force-dynamic';

/**
 * Returns the URL only if it is a syntactically valid http(s) URL; otherwise
 * null. Prevents `javascript:`/`data:` scheme execution when rendering
 * API-provided source links as anchors in the admin context.
 */
function safeExternalHref(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export default async function ResearchDetailPage({ params }: { params: { id: string } }) {
  const res = await read<ResearchResult>(`/research/${params.id}`);

  if (!res.ok) {
    return (
      <div>
        <h2>Research</h2>
        <ApiUnreachable error={res.error} />
      </div>
    );
  }

  const r = res.data;
  const out = r.output ?? undefined;

  return (
    <div>
      <p>
        <Link href="/research">← Research</Link>
      </p>
      <h2>Research result</h2>

      <div className="panel">
        <table>
          <tbody>
            <tr>
              <th>Prospect</th>
              <td>
                {r.prospectId ? <Link href={`/prospects/${r.prospectId}`}>{r.prospectId}</Link> : '—'}
              </td>
            </tr>
            <tr>
              <th>Status</th>
              <td>
                <span className="badge">{r.status}</span>
              </td>
            </tr>
            <tr>
              <th>Confidence</th>
              <td>{fmtConfidence(r.confidence ?? out?.confidence)}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{fmtDate(r.createdAt)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {out?.summary || r.summary ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Summary</h3>
          <p>{out?.summary ?? r.summary}</p>
          {out?.companyInsights ? (
            <>
              <h4>Company insights</h4>
              <p>{out.companyInsights}</p>
            </>
          ) : null}
        </div>
      ) : null}

      {out?.personalizationPoints && out.personalizationPoints.length > 0 ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Personalization points</h3>
          <ul>
            {out.personalizationPoints.map((pt, i) => {
              const href = safeExternalHref(pt.sourceUrl);
              return (
                <li key={i}>
                  {pt.point}
                  {href ? (
                    <>
                      {' '}
                      <a href={href} target="_blank" rel="noreferrer">
                        (source)
                      </a>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {out?.sources && out.sources.length > 0 ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Sources ({out.sources.length})</h3>
          <ul>
            {out.sources.map((s, i) => {
              const href = safeExternalHref(s.url);
              return (
                <li key={i}>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {s.title ?? s.url}
                    </a>
                  ) : (
                    (s.title ?? s.url ?? '—')
                  )}
                  {s.snippet ? <div className="muted">{s.snippet}</div> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {out?.dataGaps && out.dataGaps.length > 0 ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Data gaps</h3>
          <ul>
            {out.dataGaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
