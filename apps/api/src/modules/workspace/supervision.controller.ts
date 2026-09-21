import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SUPERVISION_MODES, type SupervisionMode } from '@cocally/shared';
import { IsIn } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { SupervisionService } from './supervision.service';

class SupervisionModeDto {
  @IsIn(SUPERVISION_MODES)
  mode: SupervisionMode;
}

/**
 * Supervisor live-call control per WS-04.
 *
 * Every route is SUPERVISOR/ADMIN/OWNER only. There is no agent-facing route
 * here on purpose: an agent must not be able to enumerate who is listening to
 * them, or detach a supervisor from their own call.
 */
@Controller('supervision')
export class SupervisionController {
  constructor(private readonly supervision: SupervisionService) {}

  /** Every live call in the tenant, with names — the "pick a call" list. */
  @Get('calls')
  @Roles('SUPERVISOR', 'ADMIN', 'OWNER')
  listSupervisable(@CurrentUser() user: AuthenticatedUser) {
    return this.supervision.listSupervisable(user.tenantId);
  }

  /**
   * Join a live call. Returns LiveKit credentials scoped to the mode — the
   * client connects with them exactly as the agent's call bar does.
   */
  @Post('calls/:id/attach')
  @Roles('SUPERVISOR', 'ADMIN', 'OWNER')
  attach(@CurrentUser() user: AuthenticatedUser, @Param('id') callId: string, @Body() dto: SupervisionModeDto) {
    return this.supervision.attach(user.tenantId, { userId: user.userId }, callId, dto.mode);
  }

  /**
   * Change mode mid-call. WHISPER ↔ BARGE takes effect without reconnecting;
   * anything crossing MONITOR returns `rejoinRequired: true` because publish
   * rights are signed into the token.
   */
  @Post('calls/:id/mode')
  @Roles('SUPERVISOR', 'ADMIN', 'OWNER')
  changeMode(@CurrentUser() user: AuthenticatedUser, @Param('id') callId: string, @Body() dto: SupervisionModeDto) {
    return this.supervision.changeMode(user.tenantId, user.userId, callId, dto.mode);
  }

  /** Leave the call. Server-side eviction, not a client courtesy. */
  @Post('calls/:id/detach')
  @Roles('SUPERVISOR', 'ADMIN', 'OWNER')
  detach(@CurrentUser() user: AuthenticatedUser, @Param('id') callId: string) {
    return this.supervision.detach(user.tenantId, user.userId, callId);
  }
}
