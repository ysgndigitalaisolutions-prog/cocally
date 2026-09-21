import { Controller, Get, Header, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { ReportsService } from './reports.service';

function parseDate(v?: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
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
    return this.reports.callsCsv(user.tenantId, { campaignId, from: parseDate(from), to: parseDate(to) });
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
    return this.reports.leadsCsv(user.tenantId, { campaignId, from: parseDate(from), to: parseDate(to) });
  }

  @Get('campaign-summary.csv')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="campaign-summary.csv"')
  campaignSummary(@CurrentUser() user: AuthenticatedUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.campaignSummaryCsv(user.tenantId, { from: parseDate(from), to: parseDate(to) });
  }
}
