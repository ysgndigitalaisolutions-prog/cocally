import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { ADVANCE_RULES, TTS_PROVIDERS, type AdvanceRule, type TtsProvider } from '../../schemas/tenant.schema';
import { AuditService } from '../audit/audit.service';
import { isPlatformAdmin, PlatformAdminGuard } from './platform-admin.guard';
import { BillingService, currentPeriod } from './billing.service';
import { PlatformService } from './platform.service';

const ALL_ROLES = ['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT', 'QA', 'API_CLIENT'] as const;

class VoiceDto {
  @IsIn(TTS_PROVIDERS)
  provider: TtsProvider;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  voiceId?: string;
}

class TierDto {
  @IsNumber()
  @Min(0)
  fromMinutes: number;

  @IsNumber()
  @Min(0)
  @Max(1000)
  aiPerMinInr: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  perDialInr: number;
}

class BillToDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(20) gstin?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
}

class BillingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => TierDto)
  tiers: TierDto[];

  @IsNumber()
  @Min(0)
  @Max(10_000_000)
  monthlyAdvanceInr: number;

  @IsIn(ADVANCE_RULES)
  advanceRule: AdvanceRule;

  @IsNumber()
  @Min(0)
  @Max(28)
  gstPercent: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => BillToDto)
  billTo?: BillToDto;
}

class MoneyDto {
  @IsNumber()
  amountInr: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsDateString()
  at?: string;
}

class MonthDto {
  @Matches(/^\d{4}-\d{2}$/)
  month: string;
}

class IssueDto {
  @IsOptional() @IsInt() @Min(0) @Max(90) dueDays?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

class PaidDto {
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
}

class VoidDto {
  @IsString() @MaxLength(300) reason: string;
}

class SellerDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(20) gstin?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) paymentDetails?: string;
}

class UpdateTenantDto {
  /** null resets to the worker's default voice. */
  @IsOptional()
  @ValidateNested()
  @Type(() => VoiceDto)
  voice?: VoiceDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => BillingDto)
  billing?: BillingDto;

  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  dailyDialQuota?: number;
}

class RateCardDto {
  @IsOptional() @IsNumber() @Min(0) livekitAgentPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) livekitSipPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) livekitWebrtcPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) sttPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) llmPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) ttsPer1kChars?: number;
  @IsOptional() @IsNumber() @Min(0) recordingPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) telcoPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) fixedMonthlyUsd?: number;
  @IsOptional() @IsNumber() @Min(1) inrPerUsd?: number;
}

/**
 * CoCally's own operator screen: every tenant's usage, cost and margin, and
 * the settings only CoCally changes (voice, billing, kill switch, quota).
 * Cross-tenant by design, so it sits behind PlatformAdminGuard, not a role.
 */
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
  ) {}

  /** Every money change is recorded in the tenant's own audit log. */
  private async log(user: AuthenticatedUser, tenantId: string, action: string, entityType: string, entityId: string, after?: object) {
    await this.audit.record({
      tenantId,
      actorId: user.userId,
      actorLabel: `${user.email} (CoCally)`,
      action,
      entityType,
      entityId,
      ...(after ? { after: { ...after } as Record<string, unknown> } : {}),
    });
  }

  /** Lets the web app decide whether to show the Platform link. */
  @Get('me')
  @Roles(...ALL_ROLES)
  me(@CurrentUser() user: AuthenticatedUser) {
    return { platformAdmin: isPlatformAdmin(user) };
  }

  @Get('overview')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  overview(@Query('from') fromRaw?: string, @Query('to') toRaw?: string) {
    const now = new Date();
    const from = fromRaw ? new Date(fromRaw) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = toRaw ? new Date(toRaw) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw new BadRequestException('from/to must be valid ISO dates with from < to');
    }
    return this.platform.overview(from, to);
  }

  @Get('rate-card')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  rateCard() {
    return this.platform.rateCard();
  }

  @Put('rate-card')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  async updateRateCard(@CurrentUser() user: AuthenticatedUser, @Body() dto: RateCardDto) {
    const before = await this.platform.rateCard();
    const after = await this.platform.updateRateCard(dto);
    await this.audit.record({
      tenantId: user.tenantId,
      actorId: user.userId,
      actorLabel: user.email,
      action: 'platform.rate_card.update',
      entityType: 'PlatformSettings',
      entityId: 'default',
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  @Get('tenants/:id')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  tenant(@Param('id') id: string) {
    return this.platform.tenantDetail(id);
  }

  /** Audited in the TENANT's own log, so the tenant can see what CoCally changed. */
  @Patch('tenants/:id')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  async updateTenant(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateTenantDto) {
    const { before, after } = await this.platform.updateTenant(id, dto);
    await this.audit.record({
      tenantId: id,
      actorId: user.userId,
      actorLabel: `${user.email} (CoCally)`,
      action: 'platform.tenant.update',
      entityType: 'Tenant',
      entityId: id,
      before,
      after,
    });
    return after;
  }

  // ── Billing ────────────────────────────────────────────────────────────

  @Get('tenants/:id/billing')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  async tenantBilling(@Param('id') id: string, @Query('month') month?: string) {
    const [summary, ledger, invoices] = await Promise.all([
      this.billing.monthSummary(id, month || currentPeriod()),
      this.billing.ledger(id),
      this.billing.listInvoices(id, { includeDrafts: true }),
    ]);
    return { summary, ledger, invoices };
  }

  @Post('tenants/:id/advances')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  async recordAdvance(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: MoneyDto) {
    const res = await this.billing.recordAdvance(id, dto.amountInr, {
      receivedAt: dto.at ? new Date(dto.at) : undefined,
      reference: dto.note,
      by: user.email,
    });
    await this.log(user, id, 'billing.advance.record', 'Tenant', id, { amountInr: dto.amountInr, reference: dto.note, ...res });
    return res;
  }

  @Post('tenants/:id/adjustments')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  async recordAdjustment(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: MoneyDto) {
    const res = await this.billing.recordAdjustment(id, dto.amountInr, dto.note ?? '', user.email);
    await this.log(user, id, 'billing.adjustment.record', 'Tenant', id, { amountInr: dto.amountInr, note: dto.note, ...res });
    return res;
  }

  @Post('tenants/:id/invoices')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  generateInvoice(@Param('id') id: string, @Body() dto: MonthDto) {
    return this.billing.generateDraft(id, dto.month);
  }

  @Get('invoices/:id')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  invoice(@Param('id') id: string) {
    return this.billing.getInvoice(id);
  }

  @Post('invoices/:id/issue')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  async issue(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: IssueDto) {
    const inv = await this.billing.issue(id, user.email, dto);
    await this.log(user, inv.tenantId, 'billing.invoice.issue', 'Invoice', inv.id, { number: inv.number, totalInr: inv.totalInr });
    return inv;
  }

  @Post('invoices/:id/paid')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  async markPaid(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: PaidDto) {
    const inv = await this.billing.markPaid(id, { paidAt: dto.paidAt ? new Date(dto.paidAt) : undefined, reference: dto.reference });
    await this.log(user, inv.tenantId, 'billing.invoice.paid', 'Invoice', inv.id, { number: inv.number, reference: dto.reference });
    return inv;
  }

  @Post('invoices/:id/void')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  async voidInvoice(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: VoidDto) {
    const inv = await this.billing.void(id, user.email, dto.reason);
    await this.log(user, inv.tenantId, 'billing.invoice.void', 'Invoice', inv.id, { number: inv.number, reason: dto.reason });
    return inv;
  }

  @Get('seller')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  seller() {
    return this.billing.seller();
  }

  @Put('seller')
  @Roles(...ALL_ROLES)
  @UseGuards(PlatformAdminGuard)
  updateSeller(@Body() dto: SellerDto) {
    return this.billing.updateSeller(dto);
  }
}
