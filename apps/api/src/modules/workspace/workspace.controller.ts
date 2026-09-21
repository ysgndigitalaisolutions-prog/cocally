import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PAUSE_CODES, PRESENCE_STATES, type PauseCode, type PresenceState } from '@cocally/shared';
import { IsIn, IsOptional } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { PresenceService } from './presence.service';
import { RealtimeGateway } from './realtime.gateway';
import { TransfersService } from './transfers.service';

class SetPresenceDto {
  @IsIn(PRESENCE_STATES)
  state: PresenceState;

  /**
   * Required when `state` is BREAK — the service rejects a codeless break
   * rather than defaulting one, so adherence data is never invented.
   */
  @IsOptional()
  @IsIn(PAUSE_CODES)
  pauseCode?: PauseCode;
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

  /** Shift state for the agent header: on shift, on pause, wrap-up countdown. */
  @Get('me/shift')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER')
  shift(@CurrentUser() user: AuthenticatedUser) {
    return this.presence.shiftState(user.userId);
  }

  /**
   * Pause-code picker. Served from the server (not hardcoded in the client)
   * so the productive/unproductive split the wallboard reports on and the one
   * the agent picks from can never drift apart.
   */
  @Get('pause-codes')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER', 'QA')
  pauseCodes() {
    return this.presence.pauseCodes();
  }

  @Post('presence')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  async setPresence(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetPresenceDto) {
    await this.presence.setPresence(user.userId, dto.state, dto.pauseCode);
    this.gateway.emitToTenant(user.tenantId, 'presence.updated', { userId: user.userId, state: dto.state });
    return { ok: true };
  }

  /** Start of shift. Does not make the agent available — that is a second click. */
  @Post('clock-in')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  clockIn(@CurrentUser() user: AuthenticatedUser) {
    return this.presence.clockIn(user.userId);
  }

  /** End of shift: clears the clock and forces OFFLINE so no work routes here. */
  @Post('clock-out')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  async clockOut(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.presence.clockOut(user.userId);
    this.gateway.emitToTenant(user.tenantId, 'presence.updated', { userId: user.userId, state: 'OFFLINE' });
    return result;
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
