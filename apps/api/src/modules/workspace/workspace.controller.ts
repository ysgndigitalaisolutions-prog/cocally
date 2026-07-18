import { Body, Controller, Param, Post } from '@nestjs/common';
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

  @Post('presence')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  async setPresence(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetPresenceDto) {
    await this.presence.setPresence(user.userId, dto.state);
    this.gateway.emitToTenant(user.tenantId, 'presence.updated', { userId: user.userId, state: dto.state });
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
