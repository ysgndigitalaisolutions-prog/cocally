import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { EMPTY_USAGE, UsageService, type TenantUsage } from './usage.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;

/** Offset of `zone` from UTC at `at`, in ms (e.g. +19 800 000 for India). */
function zoneOffsetMs(at: number, zone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(at))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600_000 + Number(m[3]) * 60_000);
}

/** Midnight at the start of `day` (YYYY-MM-DD) in `zone`, as a UTC instant. */
function zonedMidnight(day: string, zone: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  return new Date(guess - zoneOffsetMs(guess, zone));
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function todayIn(zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
}

/**
 * The tenant's usage board: what was dialled, answered and talked, per day.
 * Counts only, no money (billing is shown separately). Same measurements as
 * invoices (`UsageService`), so the two can never disagree.
 */
@Controller('usage')
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
  ) {}

  @Get('daily')
  @Roles('OWNER', 'ADMIN')
  async daily(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') fromQ?: string,
    @Query('to') toQ?: string,
    @Query('tz') tzQ?: string,
  ) {
    const tz = tzQ || 'Asia/Kolkata';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new BadRequestException('unknown time zone');
    }
    const to = toQ || todayIn(tz);
    const from = fromQ || addDays(to, -6);
    if (!DAY.test(from) || !DAY.test(to) || from > to) throw new BadRequestException('from/to must be YYYY-MM-DD, from <= to');
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (span > MAX_DAYS) throw new BadRequestException(`at most ${MAX_DAYS} days`);

    const range = { from: zonedMidnight(from, tz), to: zonedMidnight(addDays(to, 1), tz), tenantId: user.tenantId, timezone: tz };
    const [byDay, totalsMap, byCampaignMap] = await Promise.all([
      this.usage.usage({ ...range, groupBy: 'day' }),
      this.usage.usage(range),
      this.usage.usage({ ...range, groupBy: 'campaignId' }),
    ]);

    const days: Array<{ day: string } & TenantUsage> = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push({ day: d, ...(byDay.get(d) ?? EMPTY_USAGE) });

    const ids = [...byCampaignMap.keys()].filter((id) => Types.ObjectId.isValid(id));
    const names = new Map(
      (await this.campaignModel.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }).select('name').lean().exec()).map(
        (c) => [c._id.toString(), c.name] as const,
      ),
    );
    const byCampaign = [...byCampaignMap.entries()]
      .map(([id, u]) => ({ campaignId: id, name: names.get(id) ?? 'Manual / no campaign', ...u }))
      .sort((a, b) => b.dials - a.dials);

    return { from, to, timezone: tz, totals: totalsMap.get(user.tenantId) ?? { ...EMPTY_USAGE }, days, byCampaign };
  }
}
