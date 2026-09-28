interface LeadStateLike {
  stateReason?: string;
  timeline?: { kind: string; detail?: string }[];
}

/**
 * Why a lead is in its current state, in words a supervisor can act on
 * ("Busy or declined the call — 5 of 5 attempts used").
 *
 * Leads that changed state before `stateReason` existed fall back to the
 * newest STATE_CHANGE entry on their timeline.
 */
export function leadStateReason(lead: LeadStateLike): string | undefined {
  if (lead.stateReason) return lead.stateReason;
  const timeline = lead.timeline ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].kind === 'STATE_CHANGE') return timeline[i].detail;
  }
  return undefined;
}
