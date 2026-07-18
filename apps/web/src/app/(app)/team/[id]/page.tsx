'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import AgentInsightsView from '@/components/AgentInsightsView';

/** Admin/supervisor drill-down into one team member. */
export default function TeamMemberPage() {
  const params = useParams<{ id: string }>();
  return (
    <div className="space-y-4">
      <Link href="/team" className="text-sm" style={{ color: 'var(--text-dim)' }}>
        ← Back to team
      </Link>
      <AgentInsightsView target={params.id} />
    </div>
  );
}
