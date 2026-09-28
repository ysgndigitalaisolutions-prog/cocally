'use client';

import CallsTable from '@/components/ops/CallsTable';

export default function OpsCallsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Calls</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Every tenant&apos;s calls, with what each cost us and what it was billed.</p>
      </div>
      <CallsTable />
    </div>
  );
}
