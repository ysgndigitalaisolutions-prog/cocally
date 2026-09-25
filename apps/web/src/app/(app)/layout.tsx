'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import { disconnectSocket } from '@/lib/socket';
import { api } from '@/lib/api';
import { homeFor } from '@/lib/roles';
import { canVisit } from '@/lib/nav';
import GlobalCallBar from '@/components/GlobalCallBar';
import Sidebar from '@/components/Sidebar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, setUser, activeCall } = useAppStore();

  useEffect(() => {
    const token = localStorage.getItem('cocally.token');
    const stored = localStorage.getItem('cocally.user');
    // A token without its user (a session from before `cocally.user` was
    // written) would leave the shell waiting forever; start over instead.
    if (!token || !stored) {
      router.replace('/login');
      return;
    }
    setUser(JSON.parse(stored));
  }, [router, setUser]);

  // Pages outside this user's nav bounce home rather than rendering a wall
  // of 403s. The API still enforces every role; this only keeps the UI honest.
  useEffect(() => {
    if (user && !canVisit(user, pathname)) router.replace(homeFor(user));
  }, [user, pathname, router]);

  // Presence keep-alive: the server signs out staffed agents who stop checking
  // in, so a closed laptop can't leave a ghost agent taking transfer offers.
  useEffect(() => {
    if (!localStorage.getItem('cocally.token')) return;
    const beat = () => api.post('/workspace/heartbeat').catch(() => undefined);
    beat();
    const timer = setInterval(beat, 30_000);
    return () => clearInterval(timer);
  }, [pathname]);

  function logout() {
    localStorage.removeItem('cocally.token');
    localStorage.removeItem('cocally.user');
    disconnectSocket();
    router.replace('/login');
  }

  // Nothing role-dependent renders until the user is known: no flash of the
  // full nav, and no page firing requests its role cannot make. My security
  // is the exception because the 2FA-required flow must always reach it.
  const ready = Boolean(user) || pathname.startsWith('/security');

  return (
    <div className="flex min-h-screen">
      {user ? (
        <Sidebar user={user} pathname={pathname} onLogout={logout} />
      ) : (
        <aside className="w-56 shrink-0 border-r border-border bg-surface" aria-hidden />
      )}
      <main className="flex-1 overflow-x-hidden p-8" style={{ paddingBottom: activeCall ? '5rem' : undefined }}>
        {ready && children}
      </main>
      <GlobalCallBar />
    </div>
  );
}
