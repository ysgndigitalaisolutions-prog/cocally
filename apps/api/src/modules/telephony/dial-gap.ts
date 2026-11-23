/**
 * Spacing between a campaign's dials (23 Nov, Nithin): calls go out one at a
 * time, 3-5 s apart, and a line that frees up waits 3-5 s before the next dial.
 * Before this the dialer placed every free slot in the same instant.
 *
 * In memory per API process: a restart only means the first dial after it
 * goes out without the wait.
 */
export interface DialGapSeconds {
  min: number;
  max: number;
}

export const DEFAULT_DIAL_GAP: DialGapSeconds = { min: 3, max: 5 };

/** The campaign's gap, or the default; max 0 turns spacing off. */
export function gapOf(campaign: { dialGapSeconds?: Partial<DialGapSeconds> | null }): DialGapSeconds {
  const g = campaign.dialGapSeconds;
  if (!g || typeof g.min !== 'number' || typeof g.max !== 'number') return DEFAULT_DIAL_GAP;
  const min = Math.max(0, g.min);
  return { min, max: Math.max(min, g.max) };
}

export class DialGap {
  private readonly nextAt = new Map<string, number>();
  private readonly lastActive = new Map<string, number>();

  constructor(private readonly random: () => number = Math.random) {}

  private waitMs(gap: DialGapSeconds): number {
    return Math.round((gap.min + this.random() * (gap.max - gap.min)) * 1000);
  }

  /** May this campaign dial now? `active` is its live calls; a drop means a line just freed. */
  ready(campaignId: string, active: number, now: number, gap: DialGapSeconds): boolean {
    if (gap.max <= 0) return true;
    const before = this.lastActive.get(campaignId);
    this.lastActive.set(campaignId, active);
    if (before !== undefined && active < before) {
      this.nextAt.set(campaignId, Math.max(this.nextAt.get(campaignId) ?? 0, now + this.waitMs(gap)));
    }
    return now >= (this.nextAt.get(campaignId) ?? 0);
  }

  /** A dial just went out: the next waits the gap. */
  placed(campaignId: string, now: number, gap: DialGapSeconds): void {
    if (gap.max <= 0) return;
    // The live count catches up by itself once the call is registered; counting
    // it here too would read the gap before that as a hang-up.
    this.nextAt.set(campaignId, now + this.waitMs(gap));
  }
}
