import { BadRequestException, Body, Controller, ConflictException, Get, Post, Param } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { config } from '../../common/config';
import { normalizePhone, regionOf } from '../leads/phone.util';
import { CallOrchestratorService } from './call-orchestrator.service';
import { CliService } from './cli.service';
import { LivekitService } from './livekit.service';

/** CLI pool management + health dashboard per TEL-07. */
@Controller('cli')
export class CliController {
  /** One test call at a time: each takes a slot on the carrier line. */
  private testing = false;

  constructor(
    private readonly cli: CliService,
    private readonly livekit: LivekitService,
    private readonly orchestrator: CallOrchestratorService,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.cli.list(user.tenantId);
  }

  /** What a call shows when the campaign has no caller ID ticked: each trunk's own number. */
  @Get('default')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR')
  defaults() {
    return this.livekit.trunkCallerIds();
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  add(@CurrentUser() user: AuthenticatedUser, @Body() body: { number: string; geoRegion?: string; countryPackCode: string }) {
    return this.cli.addNumber(user.tenantId, body);
  }

  @Post(':id/reinstate')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR')
  reinstate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body('reason') reason: string) {
    return this.cli.reinstate(user.tenantId, { id: user.userId, label: user.email }, id, reason ?? '');
  }

  @Post(':id/quarantine')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR')
  quarantine(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body('reason') reason: string) {
    return this.cli.quarantine(user.tenantId, { id: user.userId, label: user.email }, id, reason ?? '');
  }

  /**
   * Ring a phone with `from` as the caller ID, before the number is added or
   * ticked on a campaign. The answer says whether the carrier let it through;
   * the person holding the phone says which number it showed.
   */
  @Post('test')
  @Roles('OWNER', 'ADMIN')
  async test(@Body() body: { from?: string; to?: string }) {
    const parse = (raw: string | undefined, what: string) => {
      const r = normalizePhone(raw ?? '', regionOf(raw ?? '', 'AU'));
      if (!r.ok) throw new BadRequestException(`${what}: ${r.reason}`);
      return r.value.e164;
    };
    const from = parse(body.from, 'Caller ID');
    const to = parse(body.to, 'Number to ring');
    if (to.startsWith('+61') && this.orchestrator.activeOnAuLine() >= config.livekit.auLineMaxCalls) {
      throw new ConflictException('The Australian line is full right now. Try again when a call ends.');
    }
    if (this.testing) throw new ConflictException('Another caller ID test is running. Try again in a minute.');
    this.testing = true;
    try {
      return { from, to, ...(await this.livekit.testCallerId(from, to)) };
    } finally {
      this.testing = false;
    }
  }
}
