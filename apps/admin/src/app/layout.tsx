import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agentic Email — Admin',
  description: 'Admin dashboard for the agentic email automation system.',
};

const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/', label: 'Dashboard' },
  { href: '/prospects', label: 'Prospects' },
  { href: '/research', label: 'Research' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/inbound', label: 'Inbound' },
  { href: '/suppression', label: 'Suppression' },
  { href: '/audit', label: 'Audit Logs' },
  { href: '/settings', label: 'Settings' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="layout">
          <nav className="nav">
            <h1>
              Agentic Email
              <span className="brand-sub">admin dashboard</span>
            </h1>
            <ul>
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href}>{item.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
