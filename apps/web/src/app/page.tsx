'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeFor } from '@/lib/roles';

/**
 * Client-side so it can read the session: a server redirect cannot see
 * localStorage and used to send every role to the dashboard, which agents
 * are not allowed to load.
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const token = localStorage.getItem('cocally.token');
    const stored = localStorage.getItem('cocally.user');
    router.replace(token && stored ? homeFor(JSON.parse(stored)) : '/login');
  }, [router]);
  return null;
}
