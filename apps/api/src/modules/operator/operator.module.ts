import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Call, CallSchema } from '../../schemas/call.schema';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { Lead, LeadSchema } from '../../schemas/lead.schema';
import { Operator, OperatorSchema, OpsAuditLog, OpsAuditLogSchema } from '../../schemas/operator.schema';
import { Client, ClientSchema, Tenant, TenantSchema } from '../../schemas/tenant.schema';
import { User, UserSchema } from '../../schemas/user.schema';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { OperatorAuthController } from './operator-auth.controller';
import { OperatorAuthGuard } from './operator-auth.guard';
import { OperatorAuthService } from './operator-auth.service';
import { OpsAuditService } from './ops-audit.service';
import { OpsCallsService } from './ops-calls.service';
import { OpsController } from './ops.controller';
import { OpsTenantsService } from './ops-tenants.service';

/** The CoCally ops console: operator accounts, and everything run across tenants. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Operator.name, schema: OperatorSchema },
      { name: OpsAuditLog.name, schema: OpsAuditLogSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: Client.name, schema: ClientSchema },
      { name: User.name, schema: UserSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: Call.name, schema: CallSchema },
      { name: Lead.name, schema: LeadSchema },
    ]),
    AuditModule,
    AuthModule,
    PlatformModule,
  ],
  controllers: [OperatorAuthController, OpsController],
  providers: [OperatorAuthGuard, OperatorAuthService, OpsAuditService, OpsCallsService, OpsTenantsService],
})
export class OperatorModule {}
