import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PRESENCE_STATES, type PresenceState } from '@cocally/shared';
import { IsIn } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { PresenceService } from './presence.service';
import { RealtimeGateway } from './realtime.gateway';
import { TransfersService } from './transfers.service';

class SetPresenceDto {
  @IsIn(PRESENCE_STATES)
  state: PresenceState;
}

@Controller('workspace')
export class WorkspaceController {
  constructor(
    private readonly presence: PresenceService,
    private readonly transfers: TransfersService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /** Own presence — server truth, so the UI never shows a stale local state. */
  @Get('me')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER', 'QA')
  async me(@CurrentUser() user: AuthenticatedUser) {
    const presence = await this.presence.getPresence(user.userId);
    return { userId: user.userId, presence: presence ?? 'OFFLINE' };
  }

  /** Live team roster with presence — powers the "who's online" panels. */
  @Get('team')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER', 'QA')
  team(@CurrentUser() user: AuthenticatedUser) {
    return this.presence.team(user.tenantId);
  }

  @Post('presence')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  async setPresence(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetPresenceDto) {
    await this.presence.setPresence(user.userId, dto.state);
    this.gateway.emitToTenant(user.tenantId, 'presence.updated', { userId: user.userId, state: dto.state });
    return { ok: true };
  }

  /** Client keep-alive; the sweep signs out anyone who stops sending these. */
  @Post('heartbeat')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN', 'QA', 'OWNER')
  async heartbeat(@CurrentUser() user: AuthenticatedUser) {
    await this.presence.heartbeat(user.userId);
    return { ok: true };
  }

  @Post('transfers/:id/accept')
  @Roles('AGENT', 'SUPERVISOR')
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id') transferId: string) {
    return this.transfers.accept(transferId, user.userId);
  }

  @Post('transfers/:id/decline')
  @Roles('AGENT', 'SUPERVISOR')
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id') transferId: string) {
    return this.transfers.decline(transferId, user.userId);
  }
}
