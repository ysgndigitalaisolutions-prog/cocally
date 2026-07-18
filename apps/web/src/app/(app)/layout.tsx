'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import { disconnectSocket } from '@/lib/socket';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'] },
  { href: '/workspace', label: 'Workspace', roles: ['AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER'] },
  { href: '/insights', label: 'My insights', roles: ['AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER'] },
  { href: '/team', label: 'Team insights', roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'] },
  { href: '/campaigns', label: 'Campaigns', roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'] },
  { href: '/flows', label: 'Flows', roles: ['OWNER', 'ADMIN', 'SUPERVISOR'] },
  { href: '/leads', label: 'Leads', roles: ['OWNER', 'ADMIN', 'SUPERVISOR'] },
  { href: '/calls', label: 'Calls', roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'] },
  { href: '/providers', label: 'Providers', roles: ['OWNER', 'ADMIN'] },
  { href: '/audit', label: 'Audit log', roles: ['OWNER', 'ADMIN', 'QA'] },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, setUser } = useAppStore();

  useEffect(() => {
    const token = localStorage.getItem('cocally.token');
    if (!token) {
      router.replace('/login');
      return;
    }
    const stored = localStorage.getItem('cocally.user');
    if (stored) setUser(JSON.parse(stored));
  }, [router, setUser]);

  function logout() {
    localStorage.removeItem('cocally.token');
    localStorage.removeItem('cocally.user');
    disconnectSocket();
    router.replace('/login');
  }

  const visibleNav = NAV.filter((item) => !user || item.roles.some((r) => user.roles.includes(r)));

  return (
    <div className="flex min-h-screen">
      <aside
        className="flex w-56 shrink-0 flex-col border-r p-4"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <div className="mb-8 px-2 text-xl font-bold">
          Co<span style={{ color: 'var(--accent)' }}>Cally</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {visibleNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm font-medium"
              style={
                pathname.startsWith(item.href)
                  ? { background: 'var(--surface-2)', color: 'var(--accent)' }
                  : { color: 'var(--text-dim)' }
              }
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          <p className="truncate px-2 text-sm font-medium">{user?.name}</p>
          <p className="truncate px-2 text-xs" style={{ color: 'var(--text-dim)' }}>
            {user?.roles.join(', ')}
          </p>
          <button onClick={logout} className="btn btn-ghost mt-3 w-full text-sm">
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden p-8">{children}</main>
    </div>
  );
}
