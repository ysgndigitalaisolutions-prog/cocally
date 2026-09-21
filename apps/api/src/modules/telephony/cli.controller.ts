import { Body, Controller, Get, Post, Param } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { CliService } from './cli.service';

/** CLI pool management + health dashboard per TEL-07. */
@Controller('cli')
export class CliController {
  constructor(private readonly cli: CliService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.cli.list(user.tenantId);
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
}
