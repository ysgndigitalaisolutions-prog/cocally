import { Controller, Get, Header, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { ReportsService } from './reports.service';

function parseDate(v?: string, endOfDay = false): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  // A bare date from the picker means the whole local day, not 00:00 UTC —
  // otherwise the last day of every export (and all of "today") is missing.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const local = new Date(`${v}T00:00:00`);
    if (endOfDay) local.setHours(23, 59, 59, 999);
    return local;
  }
  return d;
}

/** CSV exports for BPO client reporting per progress-and-next-steps.md P1 #13. */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('calls.csv')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="calls.csv"')
  calls(
    @CurrentUser() user: AuthenticatedUser,
    @Query('campaignId') campaignId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.callsCsv(user.tenantId, { campaignId, from: parseDate(from), to: parseDate(to, true) });
  }

  @Get('leads.csv')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="leads.csv"')
  leads(
    @CurrentUser() user: AuthenticatedUser,
    @Query('campaignId') campaignId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.leadsCsv(user.tenantId, { campaignId, from: parseDate(from), to: parseDate(to, true) });
  }

  @Get('campaign-summary.csv')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="campaign-summary.csv"')
  campaignSummary(@CurrentUser() user: AuthenticatedUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.campaignSummaryCsv(user.tenantId, { from: parseDate(from), to: parseDate(to, true) });
  }
}
