import Link from 'next/link';
import { read } from '../../lib/api';
import { asArray, fmtDate } from '../../lib/format';
import { ApiUnreachable } from '../../components/ApiError';
import type { ApprovalItem, DraftWithPolicy, Json } from '../../lib/types';
import { ApprovalActions } from './ApprovalActions';
import { SendNowAction } from './SendNowAction';

/** Always render at request time so the pending-approvals list stays live. */
export const dynamic = 'force-dynamic';

/** Approval type that maps to an outreach draft send (mirrors `@app/shared`). */
const OUTREACH_SEND = 'outreach_send';

/** Policy info surfaced per approval item: eligibility + denial reasons. */
interface PolicyInfo {
  autoSendEligible?: boolean;
  denialReasons: string[];
}

/** Read denial reasons / eligibility from an arbitrary JSON payload, tolerantly. */
function policyFromJson(payload: Json | undefined): PolicyInfo {
  const out: PolicyInfo = { denialReasons: [] };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
  const obj = payload as Record<string, Json>;
  if (typeof obj.autoSendEligible === 'boolean') out.autoSendEligible = obj.autoSendEligible;
  const reasons = obj.denialReasons;
  if (Array.isArray(reasons)) {
    out.denialReasons = reasons.filter((r): r is string => typeof r === 'string');
  }
  return out;
}

/** Merge two PolicyInfos, preferring defined eligibility and unioning reasons. */
function mergePolicy(a: PolicyInfo, b: PolicyInfo): PolicyInfo {
  return {
    autoSendEligible: a.autoSendEligible ?? b.autoSendEligible,
    denialReasons: a.denialReasons.length ? a.denialReasons : b.denialReasons,
  };
}

/**
 * Resolve policy info for an item: prefer the item payload and attached draft;
 * otherwise fetch the related draft (`GET /drafts/:id`) which may carry
 * `autoSendEligible` / `denialReasons`. Failures degrade to "unknown".
 */
async function resolvePolicy(item: ApprovalItem): Promise<PolicyInfo> {
  let info = mergePolicy(policyFromJson(item.payload), policyFromJson(item.draft as Json));
  const hasInfo = info.autoSendEligible !== undefined || info.denialReasons.length > 0;
  if (!hasInfo && item.draftId) {
    const res = await read<DraftWithPolicy>(`/drafts/${item.draftId}`);
    if (res.ok) {
      info = mergePolicy(info, {
        autoSendEligible: res.data.autoSendEligible,
        denialReasons: Array.isArray(res.data.denialReasons) ? res.data.denialReasons : [],
      });
    }
  }
  return info;
}

/** Approvals page: lists pending items with policy eligibility + send action. */
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

  // Resolve policy info for every item in parallel (each read never throws).
  const policies = await Promise.all(approvals.map((a) => resolvePolicy(a)));

  return (
    <div>
      <h2>Pending approvals</h2>
      <p className="muted">
        Pending items include gated sends and escalations. Approving or rejecting calls the API,
        which records the decision in the audit log and releases or cancels the pending action.
      </p>
      {approvals.length === 0 ? (
        <p className="muted">No pending approvals.</p>
      ) : (
        approvals.map((a, i) => {
          const policy: PolicyInfo = policies[i] ?? { denialReasons: [] };
          const isOutreachSend = a.type === OUTREACH_SEND;
          const draftId = a.draftId ?? a.draft?.id ?? null;
          return (
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

              {/* Policy eligibility + denial reasons */}
              <div style={{ margin: '8px 0' }}>
                <span
                  className="badge"
                  style={
                    policy.autoSendEligible === true
                      ? { background: '#dcfce7', borderColor: '#86efac', color: '#166534' }
                      : policy.autoSendEligible === false
                        ? { background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }
                        : undefined
                  }
                >
                  {policy.autoSendEligible === true
                    ? 'auto-send eligible'
                    : policy.autoSendEligible === false
                      ? 'NOT auto-send eligible'
                      : 'eligibility unknown'}
                </span>
                {policy.denialReasons.length ? (
                  <div className="muted" style={{ marginTop: 4 }}>
                    <strong>Policy denial reasons:</strong>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {policy.denialReasons.map((r, j) => (
                        <li key={j}>{r}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              {a.draft ? (
                <div style={{ marginTop: 8 }}>
                  <div>
                    <strong>Subject:</strong> {a.draft.subject ?? '—'}
                  </div>
                  {a.draft.toEmail ? <div className="muted">To: {a.draft.toEmail}</div> : null}
                  <pre className="body">{a.draft.bodyText ?? a.draft.body ?? '(no body)'}</pre>
                </div>
              ) : (
                <p className="muted" style={{ marginTop: 8 }}>
                  No draft attached.
                </p>
              )}

              <div style={{ marginTop: 12 }}>
                <ApprovalActions approvalId={a.id} />
                {isOutreachSend && draftId ? <SendNowAction draftId={draftId} /> : null}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
