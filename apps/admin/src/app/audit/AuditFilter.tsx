'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function AuditFilter({ entityType, limit }: { entityType: string; limit: number }) {
  const router = useRouter();
  const [value, setValue] = useState(entityType);
  const [lim, setLim] = useState(String(limit));

  function apply(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (value) params.set('entityType', value);
    if (lim) params.set('limit', lim);
    const qs = params.toString();
    router.push(qs ? `/audit?${qs}` : '/audit');
  }

  return (
    <form className="inline" onSubmit={apply}>
      <div className="field">
        <label htmlFor="af-entity">Entity type</label>
        <input
          id="af-entity"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. DraftEmail, Prospect"
        />
      </div>
      <div className="field">
        <label htmlFor="af-limit">Limit</label>
        <input id="af-limit" type="number" min={1} value={lim} onChange={(e) => setLim(e.target.value)} />
      </div>
      <button type="submit">Filter</button>
    </form>
  );
}
