import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('kpis')
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'OWNER')
  kpis(
    @CurrentUser() user: AuthenticatedUser,
    @Query('campaignId') campaignId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.kpis(
      user.tenantId,
      campaignId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Get('funnel')
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'OWNER')
  funnel(@CurrentUser() user: AuthenticatedUser, @Query('campaignId') campaignId?: string) {
    return this.analytics.funnel(user.tenantId, campaignId);
  }

  @Get('objections')
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'OWNER')
  objections(@CurrentUser() user: AuthenticatedUser, @Query('campaignId') campaignId?: string) {
    return this.analytics.objections(user.tenantId, campaignId);
  }

  @Get('outcomes')
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'OWNER')
  outcomes(@CurrentUser() user: AuthenticatedUser, @Query('campaignId') campaignId?: string) {
    return this.analytics.outcomes(user.tenantId, campaignId);
  }

  @Get('heatmap')
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'OWNER')
  heatmap(@CurrentUser() user: AuthenticatedUser, @Query('campaignId') campaignId?: string) {
    return this.analytics.heatmap(user.tenantId, campaignId);
  }
}
