'use client';

import AgentInsightsView from '@/components/AgentInsightsView';

/** The agent's own performance page: "how is my day/month going?" */
export default function MyInsightsPage() {
  return <AgentInsightsView target="me" title="My insights" />;
}
