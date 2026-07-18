import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { CampaignsService } from './campaigns.service';

class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsOptional()
  @IsString()
  countryPackCode?: string;
}

class SetStatusDto {
  @IsIn(['ACTIVE', 'PAUSED', 'COMPLETED'])
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
}

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'AGENT')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.campaignsService.list(user.tenantId);
  }

  @Get(':id')
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.campaignsService.get(user.tenantId, id);
  }

  @Post()
  @Roles('ADMIN')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCampaignDto) {
    return this.campaignsService.create(user.tenantId, { id: user.userId, label: user.email }, dto);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() patch: Record<string, unknown>) {
    return this.campaignsService.update(user.tenantId, { id: user.userId, label: user.email }, id, patch);
  }

  /** Supervisors can pause per §2; only admins can (re)activate. */
  @Post(':id/status')
  @Roles('ADMIN', 'SUPERVISOR')
  setStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.campaignsService.setStatus(user.tenantId, { id: user.userId, label: user.email }, id, dto.status);
  }
}
