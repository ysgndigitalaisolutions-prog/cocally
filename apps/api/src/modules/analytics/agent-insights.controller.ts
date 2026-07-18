import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { AgentInsightsService, type InsightRange } from './agent-insights.service';

function parseRange(from?: string, to?: string, granularity?: string): InsightRange {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestException('Invalid from/to date');
  }
  const unit = granularity ?? 'day';
  if (unit !== 'hour' && unit !== 'day' && unit !== 'month') {
    throw new BadRequestException('granularity must be hour|day|month');
  }
  return { from: start, to: end, granularity: unit };
}

@Controller('analytics/agents')
export class AgentInsightsController {
  constructor(private readonly insights: AgentInsightsService) {}

  /** The agent's own performance view — every floor role can see themself. */
  @Get('me')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER', 'QA')
  me(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.insights.memberStats(user.tenantId, user.userId, parseRange(from, to, granularity));
  }

  /** Roster: per-member KPIs + AI-vs-human floor timeline. */
  @Get('team')
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'OWNER')
  team(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.insights.teamStats(user.tenantId, parseRange(from, to, granularity));
  }

  /** Drill-down into one member (tenant-scoped). */
  @Get(':id')
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'OWNER')
  member(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.insights.memberStats(user.tenantId, id, parseRange(from, to, granularity));
  }
}
