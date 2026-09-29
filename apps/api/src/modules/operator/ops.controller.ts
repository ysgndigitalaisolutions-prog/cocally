import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/auth/public.decorator';
import { BillingService, currentPeriod } from '../platform/billing.service';
import { PlatformService } from '../platform/platform.service';
import { CurrentOperator, OperatorAuthGuard, type AuthenticatedOperator } from './operator-auth.guard';
import { OperatorAuthService } from './operator-auth.service';
import { OpsAuditService } from './ops-audit.service';
import { OpsCallsService } from './ops-calls.service';
import { OpsTenantsService } from './ops-tenants.service';
import {
  ActiveDto,
  CreateOperatorDto,
  CreateTenantDto,
  InviteUserDto,
  IssueDto,
  MoneyDto,
  MonthDto,
  PaidDto,
  RateCardDto,
  RolesDto,
  SellerDto,
  UpdateTenantDto,
  VoidDto,
} from './ops.dto';

function parseDate(raw: string | undefined, field: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} is not a valid date`);
  return d;
}

/**
 * The CoCally ops console API. Every route needs an operator session
 * (OperatorAuthGuard); `@Public()` only switches off the tenant JWT and role
 * guards, which know nothing about operators. Every change is written to the
 * ops audit log and, when it touches a tenant, to that tenant's log too.
 */
@Public()
@UseGuards(OperatorAuthGuard)
@Controller('operator')
export class OpsController {
  constructor(
    private readonly tenants: OpsTenantsService,
    private readonly calls: OpsCallsService,
    private readonly billing: BillingService,
    private readonly platform: PlatformService,
    private readonly operators: OperatorAuthService,
    private readonly audit: OpsAuditService,
  ) {}

  // ── Overview ───────────────────────────────────────────────────────────

  @Get('overview')
  async overview(@Query('from') fromRaw?: string, @Query('to') toRaw?: string) {
    const now = new Date();
    const from = parseDate(fromRaw, 'from') ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const to = parseDate(toRaw, 'to') ?? now;
    if (from >= to) throw new BadRequestException('from must be before to');
    const [overview, tenants, overdue] = await Promise.all([
      this.platform.overview(from, to),
      this.tenants.list(),
      this.billing.listAllInvoices({ overdueOnly: true }),
    ]);
    const alerts: Array<{ level: 'bad' | 'warn' | 'info'; tenantId?: string; text: string }> = [];
    for (const inv of overdue) {
      alerts.push({ level: 'bad', tenantId: inv.tenantId, text: `${inv.tenantName}: invoice ${inv.number} is overdue (₹${inv.totalInr.toLocaleString('en-IN')})` });
    }
    for (const t of tenants) {
      if (!t.active) alerts.push({ level: 'info', tenantId: t.id, text: `${t.name} is deactivated` });
      else if (t.paused) alerts.push({ level: 'warn', tenantId: t.id, text: `${t.name}: dialling is paused` });
      if (t.active && !t.billingSet) alerts.push({ level: 'warn', tenantId: t.id, text: `${t.name}: billing terms not confirmed (using the pilot quote)` });
      if (t.active && t.monthBilledInr > t.creditBalanceInr && t.creditBalanceInr >= 0 && t.monthBilledInr > 0) {
        alerts.push({
          level: 'warn',
          tenantId: t.id,
          text: `${t.name}: this month's usage (₹${Math.round(t.monthBilledInr).toLocaleString('en-IN')}) exceeds the advance left (₹${Math.round(t.creditBalanceInr).toLocaleString('en-IN')})`,
        });
      }
    }
    return { ...overview, tenants, alerts };
  }

  // ── Tenants ────────────────────────────────────────────────────────────

  @Get('tenants')
  listTenants() {
    return this.tenants.list();
  }

  @Post('tenants')
  async createTenant(@CurrentOperator() op: AuthenticatedOperator, @Body() dto: CreateTenantDto, @Req() req: Request) {
    const res = await this.tenants.create(dto);
    await this.audit.record(op, {
      action: 'tenant.create',
      tenantId: res.tenant.id,
      entityType: 'Tenant',
      entityId: res.tenant.id,
      after: { name: res.tenant.name, slug: res.tenant.slug, region: res.tenant.region, owner: res.owner.phone },
      ip: req.ip,
    });
    return res;
  }

  @Get('tenants/:id')
  tenant(@Param('id') id: string) {
    return this.tenants.detail(id);
  }

  @Patch('tenants/:id')
  async updateTenant(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Body() dto: UpdateTenantDto, @Req() req: Request) {
    const { before, after } = await this.tenants.update(id, dto);
    const action =
      dto.active === false ? 'tenant.deactivate' : dto.active === true && !before.active ? 'tenant.reactivate' : dto.paused === true ? 'tenant.pause' : dto.paused === false && before.paused ? 'tenant.resume' : 'tenant.update';
    await this.audit.record(op, { action, tenantId: id, entityType: 'Tenant', entityId: id, before, after, ip: req.ip });
    return after;
  }

  @Get('tenants/:id/campaigns')
  campaigns(@Param('id') id: string) {
    return this.tenants.campaigns(id);
  }

  @Get('tenants/:id/audit')
  tenantAudit(@Param('id') id: string) {
    return this.audit.list({ tenantId: id });
  }

  // ── Tenant users ───────────────────────────────────────────────────────

  @Get('tenants/:id/users')
  users(@Param('id') id: string) {
    return this.tenants.users(id);
  }

  @Post('tenants/:id/users')
  async inviteUser(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Body() dto: InviteUserDto) {
    const res = await this.tenants.inviteUser(id, dto);
    await this.audit.record(op, { action: 'user.invite', tenantId: id, entityType: 'User', entityId: res.user.id, after: { phone: res.user.phone, roles: res.user.roles } });
    return res;
  }

  @Post('tenants/:id/users/:userId/link')
  async reissueLink(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Param('userId') userId: string) {
    const res = await this.tenants.reissueLink(id, userId);
    await this.audit.record(op, { action: res.purpose === 'RESET' ? 'user.reset_link' : 'user.invite_link', tenantId: id, entityType: 'User', entityId: userId });
    return res;
  }

  @Post('tenants/:id/users/:userId/reset-2fa')
  async reset2fa(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Param('userId') userId: string) {
    const res = await this.tenants.reset2fa(id, userId);
    await this.audit.record(op, { action: 'user.2fa_reset', tenantId: id, entityType: 'User', entityId: userId });
    return res;
  }

  @Post('tenants/:id/users/:userId/active')
  async setUserActive(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Param('userId') userId: string, @Body() dto: ActiveDto) {
    const res = await this.tenants.setUserActive(id, userId, dto.active);
    await this.audit.record(op, { action: dto.active ? 'user.activate' : 'user.deactivate', tenantId: id, entityType: 'User', entityId: userId });
    return res;
  }

  @Post('tenants/:id/users/:userId/roles')
  async setUserRoles(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Param('userId') userId: string, @Body() dto: RolesDto) {
    const res = await this.tenants.setUserRoles(id, userId, dto.roles);
    await this.audit.record(op, { action: 'user.roles', tenantId: id, entityType: 'User', entityId: userId, before: { roles: res.before }, after: { roles: res.after } });
    return res;
  }

  // ── Billing ────────────────────────────────────────────────────────────

  @Get('tenants/:id/billing')
  async tenantBilling(@Param('id') id: string, @Query('month') month?: string) {
    const [summary, ledger, invoices] = await Promise.all([
      this.billing.monthSummary(id, month || currentPeriod()),
      this.billing.ledger(id, 200),
      this.billing.listInvoices(id, { includeDrafts: true }),
    ]);
    return { summary, ledger, invoices };
  }

  @Post('tenants/:id/advances')
  async recordAdvance(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Body() dto: MoneyDto) {
    const res = await this.billing.recordAdvance(id, dto.amountInr, {
      receivedAt: parseDate(dto.at, 'at'),
      reference: dto.note,
      by: op.email,
    });
    await this.audit.record(op, { action: 'billing.advance', tenantId: id, entityType: 'Tenant', entityId: id, after: { amountInr: dto.amountInr, reference: dto.note, ...res } });
    return res;
  }

  @Post('tenants/:id/adjustments')
  async recordAdjustment(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Body() dto: MoneyDto) {
    const res = await this.billing.recordAdjustment(id, dto.amountInr, dto.note ?? '', op.email);
    await this.audit.record(op, { action: 'billing.adjustment', tenantId: id, entityType: 'Tenant', entityId: id, after: { amountInr: dto.amountInr, note: dto.note, ...res } });
    return res;
  }

  @Post('tenants/:id/invoices')
  async generateInvoice(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Body() dto: MonthDto) {
    const inv = await this.billing.generateDraft(id, dto.month);
    await this.audit.record(op, { action: 'billing.invoice_draft', tenantId: id, entityType: 'Invoice', entityId: inv.id, after: { period: dto.month, subtotalInr: inv.subtotalInr }, mirrorToTenant: false });
    return inv;
  }

  @Get('invoices')
  invoices(@Query('status') status?: string, @Query('tenantId') tenantId?: string, @Query('overdue') overdue?: string) {
    return this.billing.listAllInvoices({ status: status || undefined, tenantId: tenantId || undefined, overdueOnly: overdue === 'true' });
  }

  @Get('invoices/:id')
  invoice(@Param('id') id: string) {
    return this.billing.getInvoice(id);
  }

  @Post('invoices/:id/issue')
  async issue(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Body() dto: IssueDto) {
    const inv = await this.billing.issue(id, op.email, dto);
    await this.audit.record(op, { action: 'billing.invoice_issue', tenantId: inv.tenantId, entityType: 'Invoice', entityId: inv.id, after: { number: inv.number, totalInr: inv.totalInr } });
    return inv;
  }

  @Post('invoices/:id/paid')
  async markPaid(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Body() dto: PaidDto) {
    const inv = await this.billing.markPaid(id, { paidAt: parseDate(dto.paidAt, 'paidAt'), reference: dto.reference });
    await this.audit.record(op, { action: 'billing.invoice_paid', tenantId: inv.tenantId, entityType: 'Invoice', entityId: inv.id, after: { number: inv.number, reference: dto.reference } });
    return inv;
  }

  @Post('invoices/:id/void')
  async voidInvoice(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Body() dto: VoidDto) {
    const inv = await this.billing.void(id, op.email, dto.reason);
    await this.audit.record(op, { action: 'billing.invoice_void', tenantId: inv.tenantId, entityType: 'Invoice', entityId: inv.id, after: { number: inv.number, reason: dto.reason } });
    return inv;
  }

  // ── Latency ────────────────────────────────────────────────────────────

  /** Voice latency for one tenant's AI calls (default: last 7 days). */
  @Get('tenants/:id/latency')
  tenantLatency(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string, @Query('campaignId') campaignId?: string) {
    return this.calls.latency({ tenantId: id, from: parseDate(from, 'from'), to: parseDate(to, 'to'), campaignId: campaignId || undefined });
  }

  // ── Calls ──────────────────────────────────────────────────────────────

  @Get('calls')
  listCalls(
    @Query('tenantId') tenantId?: string,
    @Query('campaignId') campaignId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('outcome') outcome?: string,
    @Query('amdClass') amdClass?: string,
    @Query('transferred') transferred?: string,
    @Query('phone') phone?: string,
    @Query('page') page?: string,
  ) {
    return this.calls.list({
      tenantId: tenantId || undefined,
      campaignId: campaignId || undefined,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      outcome: outcome || undefined,
      amdClass: amdClass || undefined,
      transferred: transferred === 'true',
      phone: phone || undefined,
      page: page ? Number(page) : 1,
    });
  }

  @Get('calls/:id')
  callDetail(@Param('id') id: string) {
    return this.calls.detail(id);
  }

  /** Unredacted transcript: support only, and every look is audited. */
  @Get('calls/:id/unredacted')
  async callUnredacted(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Req() req: Request) {
    const detail = await this.calls.detail(id, { unredacted: true });
    await this.audit.record(op, { action: 'call.view_unredacted', tenantId: detail.tenantId, entityType: 'Call', entityId: id, ip: req.ip });
    return detail;
  }

  @Get('calls/:id/recording')
  async recording(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Req() req: Request) {
    const res = await this.calls.recordingUrl(id);
    await this.audit.record(op, { action: 'call.recording_played', entityType: 'Call', entityId: id, ip: req.ip });
    return res;
  }

  // ── Settings ───────────────────────────────────────────────────────────

  @Get('rate-card')
  rateCard() {
    return this.platform.rateCard();
  }

  @Put('rate-card')
  async updateRateCard(@CurrentOperator() op: AuthenticatedOperator, @Body() dto: RateCardDto) {
    const before = await this.platform.rateCard();
    const after = await this.platform.updateRateCard(dto);
    await this.audit.record(op, { action: 'settings.rate_card', entityType: 'PlatformSettings', entityId: 'default', before, after });
    return after;
  }

  @Get('seller')
  seller() {
    return this.billing.seller();
  }

  @Put('seller')
  async updateSeller(@CurrentOperator() op: AuthenticatedOperator, @Body() dto: SellerDto) {
    const after = await this.billing.updateSeller(dto);
    await this.audit.record(op, { action: 'settings.seller', entityType: 'PlatformSettings', entityId: 'default', after });
    return after;
  }

  // ── Operators & audit ──────────────────────────────────────────────────

  @Get('operators')
  listOperators() {
    return this.operators.list();
  }

  @Post('operators')
  createOperator(@CurrentOperator() op: AuthenticatedOperator, @Body() dto: CreateOperatorDto) {
    return this.operators.create(op, dto.email, dto.name);
  }

  @Post('operators/:id/link')
  operatorLink(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string) {
    return this.operators.reissueLink(op, id);
  }

  @Post('operators/:id/reset-2fa')
  operatorReset2fa(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string) {
    return this.operators.reset2fa(op, id);
  }

  @Post('operators/:id/active')
  operatorActive(@CurrentOperator() op: AuthenticatedOperator, @Param('id') id: string, @Body() dto: ActiveDto) {
    return this.operators.setActive(op, id, dto.active);
  }

  @Get('audit')
  auditLog(@Query('tenantId') tenantId?: string, @Query('before') before?: string) {
    return this.audit.list({ tenantId: tenantId || undefined, before: parseDate(before, 'before'), limit: 200 });
  }
}
