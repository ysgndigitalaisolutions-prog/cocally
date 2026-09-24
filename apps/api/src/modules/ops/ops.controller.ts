import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Public } from '../../common/auth/public.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { config, isLiveTelephony } from '../../common/config';
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

  /**
   * Readiness: 503 until Mongo is connected. Used by the container healthcheck
   * and the deploy pipeline's post-deploy gate. Also reports which optional
   * subsystems are configured so a misconfigured deploy is visible in one call.
   */
  @Public()
  @Get('ready')
  ready() {
    const dbReady = this.connection.readyState === 1;
    const body = {
      status: dbReady ? 'ready' : 'not_ready',
      db: dbReady,
      env: config.nodeEnv,
      telephony: isLiveTelephony() ? 'SIP' : 'SIMULATION',
      dncr: config.dncr.enabled,
      dncrBypass: config.dncr.bypass,
      recording: config.recording.enabled,
    };
    if (!dbReady) throw new ServiceUnavailableException(body);
    return body;
  }

  @Get('channels')
  @Roles('ADMIN', 'SUPERVISOR')
  channels(@CurrentUser() user: AuthenticatedUser) {
    return { liveChannels: this.orchestrator.totalActiveForTenant(user.tenantId) };
  }
}
