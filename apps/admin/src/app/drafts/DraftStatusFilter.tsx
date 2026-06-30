'use client';

import { useRouter } from 'next/navigation';

const STATUSES = [
  '',
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'scheduled',
  'sent',
  'failed',
  'cancelled',
] as const;

export function DraftStatusFilter({ status }: { status: string }) {
  const router = useRouter();
  return (
    <div className="field">
      <label htmlFor="df-status">Filter by status</label>
      <select
        id="df-status"
        value={status}
        onChange={(e) => {
          const v = e.target.value;
          router.push(v ? `/drafts?status=${v}` : '/drafts');
        }}
      >
        {STATUSES.map((s) => (
          <option key={s || 'all'} value={s}>
            {s || 'all'}
          </option>
        ))}
      </select>
    </div>
  );
}
