import Link from 'next/link';
import { read } from '../../lib/api';
import { asArray, fmtDate } from '../../lib/format';
import { ApiUnreachable } from '../../components/ApiError';
import type { ApprovalItem } from '../../lib/types';
import { ApprovalActions } from './ApprovalActions';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const res = await read<unknown>('/approvals', { status: 'pending' });

  if (!res.ok) {
    return (
      <div>
        <h2>Approvals</h2>
        <ApiUnreachable error={res.error} />
      </div>
    );
  }

  const approvals = asArray<ApprovalItem>(res.data);

  if (approvals === null) {
    return (
      <div>
        <h2>Approvals</h2>
        <ApiUnreachable error="Unexpected response shape from /approvals." />
      </div>
    );
  }

  return (
    <div>
      <h2>Pending approvals</h2>
      <p className="muted">
        Pending items include gated sends and escalations. Approving or rejecting calls the API,
        which records the decision in the audit log and releases or cancels the pending action.
      </p>
      {approvals.length === 0 ? (
        <p className="muted">No pending approvals. 🎉</p>
      ) : (
        approvals.map((a) => (
          <div className="panel" key={a.id}>
            <div className="section-head">
              <h3 style={{ margin: 0 }}>
                <span className="badge">{a.type}</span> {a.id}
              </h3>
              <span className="muted">{fmtDate(a.createdAt)}</span>
            </div>
            {a.prospectId ? (
              <p style={{ marginBottom: 4 }}>
                Prospect: <Link href={`/prospects/${a.prospectId}`}>{a.prospectId}</Link>
              </p>
            ) : null}
            {a.reason ? <p className="muted">{a.reason}</p> : null}

            {a.draft ? (
              <div style={{ marginTop: 8 }}>
                <div>
                  <strong>Subject:</strong> {a.draft.subject ?? '—'}
                </div>
                {a.draft.toEmail ? (
                  <div className="muted">To: {a.draft.toEmail}</div>
                ) : null}
                <pre className="body">{a.draft.bodyText ?? a.draft.body ?? '(no body)'}</pre>
              </div>
            ) : (
              <p className="muted" style={{ marginTop: 8 }}>
                No draft attached.
              </p>
            )}

            <div style={{ marginTop: 12 }}>
              <ApprovalActions approvalId={a.id} />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
