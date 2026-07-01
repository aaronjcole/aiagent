'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { client } from '../../lib/client';

/** Form for creating a new prospect via the API. */
export function CreateProspect() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [title, setTitle] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyDomain, setCompanyDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await client.post('/prospects', {
        email,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        title: title || undefined,
        companyName: companyName || undefined,
        companyDomain: companyDomain || undefined,
      });
      setMsg({ kind: 'ok', text: 'Prospect created.' });
      setEmail('');
      setFirstName('');
      setLastName('');
      setTitle('');
      setCompanyName('');
      setCompanyDomain('');
      router.refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline" onSubmit={submit}>
      <div className="field">
        <label htmlFor="cp-email">Email *</label>
        <input id="cp-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cp-first">First name</label>
        <input id="cp-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cp-last">Last name</label>
        <input id="cp-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cp-title">Title</label>
        <input id="cp-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cp-company">Company</label>
        <input id="cp-company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cp-domain">Company domain</label>
        <input id="cp-domain" value={companyDomain} onChange={(e) => setCompanyDomain(e.target.value)} />
      </div>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create prospect'}
      </button>
      {msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : null}
    </form>
  );
}
