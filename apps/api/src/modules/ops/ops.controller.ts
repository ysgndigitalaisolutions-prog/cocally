import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Public } from '../../common/auth/public.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { CallOrchestratorService } from '../telephony/call-orchestrator.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/** Ops/health per PLAT-07: liveness, DB state, live channel count. */
@Controller('ops')
export class OpsController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly orchestrator: CallOrchestratorService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return {
      status: this.connection.readyState === 1 ? 'ok' : 'degraded',
      db: this.connection.readyState === 1 ? 'connected' : 'disconnected',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  @Get('channels')
  @Roles('ADMIN', 'SUPERVISOR')
  channels(@CurrentUser() user: AuthenticatedUser) {
    return { liveChannels: this.orchestrator.totalActiveForTenant(user.tenantId) };
  }
}
