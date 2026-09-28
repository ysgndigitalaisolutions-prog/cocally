import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { BillingService, currentPeriod } from './billing.service';

/**
 * The tenant's own view of what CoCally bills them: usage, the running bill,
 * their advance balance and issued invoices. Never CoCally's costs or margin,
 * and never drafts.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('summary')
  @Roles('OWNER', 'ADMIN')
  async summary(@CurrentUser() user: AuthenticatedUser, @Query('month') month?: string) {
    const s = await this.billing.monthSummary(user.tenantId, month || currentPeriod());
    // A draft is CoCally's working copy, not something sent to the tenant yet.
    return { ...s, invoice: s.invoice && s.invoice.status !== 'DRAFT' ? s.invoice : null };
  }

  @Get('ledger')
  @Roles('OWNER', 'ADMIN')
  async ledger(@CurrentUser() user: AuthenticatedUser) {
    return {
      balanceInr: await this.billing.balance(user.tenantId),
      entries: await this.billing.ledger(user.tenantId),
    };
  }

  @Get('invoices')
  @Roles('OWNER', 'ADMIN')
  invoices(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.listInvoices(user.tenantId, { includeDrafts: false });
  }

  @Get('invoices/:id')
  @Roles('OWNER', 'ADMIN')
  invoice(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.billing.getInvoice(id, user.tenantId);
  }
}
