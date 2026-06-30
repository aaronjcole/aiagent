import Link from 'next/link';
import { read } from '../../lib/api';
import { asArray, prospectName, fmtDate } from '../../lib/format';
import { ApiUnreachable, ApiSideWarning } from '../../components/ApiError';
import type { Prospect, OutreachSequence } from '../../lib/types';
import { ProspectRowActions } from './ProspectActions';
import { CreateProspect } from './CreateProspect';

export const dynamic = 'force-dynamic';

export default async function ProspectsPage() {
  const [prospectsRes, sequencesRes] = await Promise.all([
    read<unknown>('/prospects'),
    read<unknown>('/sequences'),
  ]);

  const sequences = sequencesRes.ok ? asArray<OutreachSequence>(sequencesRes.data) : null;
  // Distinguish a failed/malformed side query from a genuinely empty list.
  const sequencesError = !sequencesRes.ok
    ? sequencesRes.error
    : sequences === null
      ? 'Unexpected response shape.'
      : null;

  const prospects = prospectsRes.ok ? asArray<Prospect>(prospectsRes.data) : null;

  return (
    <div>
      <h2>Prospects</h2>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Add a prospect</h3>
        <CreateProspect />
      </div>

      {sequencesError ? <ApiSideWarning label="sequences" error={sequencesError} /> : null}

      {!prospectsRes.ok ? (
        <ApiUnreachable error={prospectsRes.error} />
      ) : prospects === null ? (
        <ApiUnreachable error="Unexpected response shape from /prospects." />
      ) : (
        <ProspectsTable prospects={prospects} sequences={sequences ?? []} />
      )}
    </div>
  );
}

function ProspectsTable({ prospects, sequences }: { prospects: Prospect[]; sequences: OutreachSequence[] }) {
  if (prospects.length === 0) {
    return <p className="muted">No prospects yet. Create one above.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Company</th>
          <th>Status</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {prospects.map((p) => (
          <tr key={p.id}>
            <td>
              <Link href={`/prospects/${p.id}`}>{prospectName(p)}</Link>
            </td>
            <td>{p.email}</td>
            <td>{p.companyName ?? p.companyDomain ?? '—'}</td>
            <td>
              <span className="badge">{p.status}</span>
            </td>
            <td>{fmtDate(p.createdAt)}</td>
            <td>
              <ProspectRowActions prospectId={p.id} sequences={sequences} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
