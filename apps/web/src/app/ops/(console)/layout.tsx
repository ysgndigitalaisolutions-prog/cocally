'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LuBuilding2, LuFileText, LuLayoutDashboard, LuPhoneCall, LuScrollText, LuSettings } from 'react-icons/lu';
import { OPS_OPERATOR_KEY, OPS_TOKEN_KEY, opsApi, type OperatorProfile } from '@/lib/ops-api';

const NAV = [
  { href: '/ops', label: 'Overview', icon: LuLayoutDashboard },
  { href: '/ops/tenants', label: 'Tenants', icon: LuBuilding2 },
  { href: '/ops/calls', label: 'Calls', icon: LuPhoneCall },
  { href: '/ops/invoices', label: 'Invoices', icon: LuFileText },
  { href: '/ops/audit', label: 'Audit log', icon: LuScrollText },
  { href: '/ops/settings', label: 'Settings', icon: LuSettings },
];

/** The ops console shell: its own session, its own nav, nothing from the tenant app. */
export default function OpsConsoleLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [operator, setOperator] = useState<OperatorProfile | null>(null);

  useEffect(() => {
    if (!localStorage.getItem(OPS_TOKEN_KEY)) {
      router.replace('/ops/login');
      return;
    }
    opsApi
      .get<OperatorProfile>('/auth/me')
      .then((r) => {
        setOperator(r.data);
        localStorage.setItem(OPS_OPERATOR_KEY, JSON.stringify(r.data));
      })
      .catch(() => router.replace('/ops/login'));
  }, [router]);

  function signOut() {
    localStorage.removeItem(OPS_TOKEN_KEY);
    localStorage.removeItem(OPS_OPERATOR_KEY);
    router.replace('/ops/login');
  }

  const active = (href: string) => (href === '/ops' ? pathname === '/ops' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <div className="flex min-h-screen">
      <aside className="no-print flex w-52 shrink-0 flex-col border-r border-border bg-surface p-4">
        <div className="mb-6 px-2">
          <p className="text-xl font-bold">
            Co<span className="text-accent">Cally</span>
          </p>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-dim">Ops console</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm"
              style={active(href) ? { background: 'var(--surface-2)', color: 'var(--accent)', fontWeight: 600 } : undefined}
            >
              <Icon aria-hidden /> {label}
            </Link>
          ))}
        </nav>
        <div className="mt-4 border-t border-border pt-4">
          <p className="truncate px-2 text-sm font-medium">{operator?.name ?? '…'}</p>
          <p className="truncate px-2 text-xs text-dim">{operator?.email}</p>
          <button onClick={signOut} className="btn btn-ghost mt-3 w-full text-sm">Sign out</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">{operator ? children : <p className="text-dim">Loading…</p>}</main>
    </div>
  );
}
