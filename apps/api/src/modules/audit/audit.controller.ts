import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { AuditService } from './audit.service';

@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'QA')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('action') action?: string,
    @Query('actions') actions?: string,
    @Query('entityType') entityType?: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditService.list(user.tenantId, {
      action,
      actions: actions ? actions.split(',').map((a) => a.trim()).filter(Boolean) : undefined,
      entityType,
      limit: limit && Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : undefined,
    });
  }
}
