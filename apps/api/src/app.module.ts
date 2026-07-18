import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { config } from './common/config';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { CountryPacksModule } from './modules/country-packs/country-packs.module';
import { EngineModule } from './modules/engine/engine.module';
import { FlowsModule } from './modules/flows/flows.module';
import { LeadsModule } from './modules/leads/leads.module';
import { OpsModule } from './modules/ops/ops.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { RecordingsModule } from './modules/recordings/recordings.module';
import { TelephonyModule } from './modules/telephony/telephony.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';

@Module({
  imports: [
    MongooseModule.forRoot(config.mongoUri),
    JwtModule.register({
      global: true,
      secret: config.jwtSecret,
      signOptions: { expiresIn: config.jwtExpiresIn },
    }),
    ScheduleModule.forRoot(),
    AuditModule,
    AuthModule,
    UsersModule,
    TenantsModule,
    CountryPacksModule,
    ProvidersModule,
    FlowsModule,
    LeadsModule,
    CampaignsModule,
    EngineModule,
    WorkspaceModule,
    RecordingsModule,
    WebhooksModule,
    TelephonyModule,
    AnalyticsModule,
    OpsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
