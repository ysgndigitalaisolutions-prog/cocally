import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Client, ClientSchema, Tenant, TenantSchema } from '../../schemas/tenant.schema';
import { AuditModule } from '../audit/audit.module';
import { TenantsController } from './tenants.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Tenant.name, schema: TenantSchema },
      { name: Client.name, schema: ClientSchema },
    ]),
    AuditModule,
  ],
  controllers: [TenantsController],
})
export class TenantsModule {}
