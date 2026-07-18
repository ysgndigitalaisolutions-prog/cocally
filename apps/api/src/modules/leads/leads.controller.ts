import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { LeadState } from '@cocally/shared';
import { IsNotEmpty, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { LeadsService, type ColumnMapping } from './leads.service';
import { SuppressionService } from './suppression.service';

class CreateListDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  campaignId?: string;

  @IsOptional()
  @IsNumber()
  priority?: number;
}

class ImportCsvDto {
  @IsString()
  @IsNotEmpty()
  listId: string;

  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsString()
  @IsNotEmpty()
  csvContent: string;

  @IsObject()
  mapping: ColumnMapping;
}

class OptOutDto {
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  source: string;
}

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly suppression: SuppressionService,
  ) {}

  @Get('lists')
  @Roles('ADMIN', 'SUPERVISOR')
  lists(@CurrentUser() user: AuthenticatedUser) {
    return this.leadsService.lists(user.tenantId);
  }

  @Post('lists')
  @Roles('ADMIN')
  createList(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateListDto) {
    return this.leadsService.createList(user.tenantId, dto);
  }

  @Post('import')
  @Roles('ADMIN')
  importCsv(@CurrentUser() user: AuthenticatedUser, @Body() dto: ImportCsvDto) {
    return this.leadsService.importCsv(user.tenantId, { id: user.userId, label: user.email }, dto);
  }

  @Post('opt-out')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT')
  optOut(@CurrentUser() user: AuthenticatedUser, @Body() dto: OptOutDto) {
    return this.suppression.optOut(user.tenantId, dto.phone, `${dto.source} (by ${user.email})`);
  }

  @Get('campaign/:campaignId')
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  byCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('campaignId') campaignId: string,
    @Query('state') state?: LeadState,
    @Query('limit') limit?: string,
  ) {
    return this.leadsService.listByCampaign(user.tenantId, campaignId, state, limit ? Number(limit) : undefined);
  }

  @Get(':id')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT', 'QA')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.get(user.tenantId, id);
  }
}
