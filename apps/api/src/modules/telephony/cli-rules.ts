import { Types } from 'mongoose';

/** Full international number with its plus. Without it the AU trunk drops the number and silently uses its default. */
export function isValidCliNumber(number: string | undefined): boolean {
  return /^\+[1-9]\d{7,14}$/.test(number ?? '');
}

/**
 * Numbers a dial may use: active, from the campaign's country (a +61 caller ID
 * fails on the Indian test route), and ticked on the campaign. Nothing ticked
 * matches nothing, so the call shows the carrier's default number: a number
 * added to the pool is only used where someone ticks it.
 */
export function cliCandidateFilter(input: { tenantId: string; poolIds: Types.ObjectId[]; countryPackCode?: string }) {
  return {
    tenantId: new Types.ObjectId(input.tenantId),
    status: 'ACTIVE' as const,
    ...(input.countryPackCode ? { countryPackCode: input.countryPackCode } : {}),
    _id: { $in: input.poolIds },
  };
}
