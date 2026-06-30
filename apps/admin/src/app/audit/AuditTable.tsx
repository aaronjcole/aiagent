'use client';

/**
 * Client-side audit log table with finer filtering applied IN-BROWSER over the
 * rows already fetched by the server component.
 *
 * The API only filters by `entityType` + `limit` (see the page), so prospect id,
 * thread id, and decision/action category are filtered here over the fetched
 * window. NOTE: filtering is over the most-recent `limit` rows only — increase
 * the limit on the page filter to widen the window if a match is missing.
 */
import { useMemo, useState } from 'react';
import { fmtDate } from '../../lib/format';
import type { AuditLog, Json } from '../../lib/types';

/** Category presets matching on the `action` field (prefix / glob-ish). */
const CATEGORIES: ReadonlyArray<{ value: string; label: string; test: (action: string) => boolean }> = [
  { value: '', label: 'All categories', test: () => true },
  { value: 'policy.denied', label: 'policy.denied', test: (a) => a === 'policy.denied' || a.startsWith('policy.denied') },
  { value: 'policy', label: 'policy.* (all policy)', test: (a) => a.startsWith('policy.') },
  { value: 'email.send', label: 'email.send.*', test: (a) => a.startsWith('email.send') },
  { value: 'email', label: 'email.* (all email)', test: (a) => a.startsWith('email.') },
  { value: 'calendar.create', label: 'calendar.create.*', test: (a) => a.startsWith('calendar.create') },
  { value: 'calendar', label: 'calendar.* (all calendar)', test: (a) => a.startsWith('calendar.') },
];

/** Read a string field from a log's metadata JSON, tolerantly. */
function metaString(metadata: Json | undefined, key: string): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const v = (metadata as Record<string, Json>)[key];
  return typeof v === 'string' ? v : null;
}

/** Does a log row reference the given prospect id (entityId or metadata)? */
function matchesProspect(log: AuditLog, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const candidates = [
    log.entityType?.toLowerCase() === 'prospect' ? log.entityId : null,
    metaString(log.metadata, 'prospectId'),
  ];
  return candidates.some((c) => c?.toLowerCase().includes(needle));
}

/** Does a log row reference the given thread id (entityId or metadata)? */
function matchesThread(log: AuditLog, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const candidates = [
    log.entityType?.toLowerCase().includes('thread') ? log.entityId : null,
    metaString(log.metadata, 'threadId'),
  ];
  return candidates.some((c) => c?.toLowerCase().includes(needle));
}

/** Filterable table of audit-log rows (by prospect, thread, and event category). */
export function AuditTable({ logs }: { logs: AuditLog[] }) {
  const [prospectId, setProspectId] = useState('');
  const [threadId, setThreadId] = useState('');
  const [category, setCategory] = useState('');

  const filtered = useMemo(() => {
    const cat = CATEGORIES.find((c) => c.value === category);
    const test = cat?.test ?? (() => true);
    return logs.filter((log) => {
      if (!matchesProspect(log, prospectId.trim())) return false;
      if (!matchesThread(log, threadId.trim())) return false;
      if (!test(log.action ?? '')) return false;
      return true;
    });
  }, [logs, prospectId, threadId, category]);

  return (
    <div>
      <div className="panel">
        <form className="inline" onSubmit={(e) => e.preventDefault()}>
          <div className="field">
            <label htmlFor="at-prospect">Prospect id (client-side)</label>
            <input
              id="at-prospect"
              value={prospectId}
              onChange={(e) => setProspectId(e.target.value)}
              placeholder="prospect id"
            />
          </div>
          <div className="field">
            <label htmlFor="at-thread">Thread id (client-side)</label>
            <input
              id="at-thread"
              value={threadId}
              onChange={(e) => setThreadId(e.target.value)}
              placeholder="thread id"
            />
          </div>
          <div className="field">
            <label htmlFor="at-category">Category (client-side)</label>
            <select id="at-category" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          {prospectId || threadId || category ? (
            <button
              type="button"
              onClick={() => {
                setProspectId('');
                setThreadId('');
                setCategory('');
              }}
            >
              Clear
            </button>
          ) : null}
        </form>
        <p className="muted" style={{ marginBottom: 0 }}>
          Showing {filtered.length} of {logs.length} fetched rows. Prospect/thread/category filters
          run in-browser over the fetched window; widen the limit above to search further back.
        </p>
      </div>

      {filtered.length === 0 ? (
        <p className="muted">No matching audit logs.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Entity</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Allowed</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((log) => (
              <tr key={log.id}>
                <td>{fmtDate(log.createdAt)}</td>
                <td>
                  {log.entityType ?? '—'}
                  {log.entityId ? <div className="muted">{log.entityId}</div> : null}
                </td>
                <td>{log.action ?? '—'}</td>
                <td>{log.actor ?? log.actorType ?? '—'}</td>
                <td>
                  {log.allowed === false ? (
                    <span className="badge">blocked</span>
                  ) : log.allowed === true ? (
                    '✓'
                  ) : (
                    '—'
                  )}
                </td>
                <td>{log.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
