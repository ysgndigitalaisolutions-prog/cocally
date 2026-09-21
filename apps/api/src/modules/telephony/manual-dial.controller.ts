import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { ManualDialService } from './manual-dial.service';

/**
 * Agent-driven manual dialing. The human picks a lead and dials it; the AI
 * auto-dialer leaves claimed leads alone. Disposition happens through the
 * existing POST /calls/:id/disposition endpoint.
 */
@Controller('manual-dial')
export class ManualDialController {
  constructor(private readonly manual: ManualDialService) {}

  @Get('queue')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  queue(@CurrentUser() user: AuthenticatedUser, @Query('campaignId') campaignId?: string) {
    return this.manual.queue(user.tenantId, user.userId, campaignId);
  }

  @Post('leads/:id/claim')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  claim(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.manual.claim(user.tenantId, user.userId, id);
  }

  @Post('leads/:id/release')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  release(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.manual.release(user.tenantId, user.userId, id);
  }

  @Post('leads/:id/dial')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  dial(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.manual.dial(user.tenantId, { id: user.userId, email: user.email }, id);
  }

  /** Step 2: agent's browser has joined the LiveKit room — actually ring the customer. */
  @Post('calls/:id/connect')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  connect(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.manual.connect(user.tenantId, user.userId, id);
  }

  @Post('calls/:id/hangup')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  hangup(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.manual.hangup(user.tenantId, user.userId, id);
  }
}
