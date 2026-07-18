import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { RecordingsService } from './recordings.service';

class LegalHoldDto {
  @IsBoolean()
  hold: boolean;
}

@Controller('recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  /** Stitched per-lead timeline per REC-01. */
  @Get('lead/:leadId/timeline')
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  timeline(@CurrentUser() user: AuthenticatedUser, @Param('leadId') leadId: string) {
    return this.recordings.leadTimeline(user.tenantId, leadId);
  }

  /** Raw (unredacted) access: role-gated and audited per REC-04. */
  @Get(':id/raw')
  @Roles('ADMIN', 'QA')
  raw(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.recordings.rawAccess(user.tenantId, { id: user.userId, label: user.email }, id);
  }

  @Post(':id/legal-hold')
  @Roles('ADMIN')
  async legalHold(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: LegalHoldDto) {
    await this.recordings.setLegalHold(user.tenantId, id, dto.hold);
    return { ok: true };
  }
}
