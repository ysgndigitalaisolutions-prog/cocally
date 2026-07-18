import { Body, Controller, Get, Post } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { IsNotEmpty, IsString } from 'class-validator';
import { Model, Types } from 'mongoose';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Client, ClientDocument, Tenant, TenantDocument } from '../../schemas/tenant.schema';
import { AuditService } from '../audit/audit.service';

class CreateClientDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}

@Controller('tenants')
export class TenantsController {
  constructor(
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA', 'AGENT')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.tenantModel.findById(user.tenantId).lean().exec();
  }

  /** Global pause-everything control per ADM-03 / kill switch per PLAT-08. */
  @Post('pause')
  @Roles('OWNER', 'ADMIN')
  async pause(@CurrentUser() user: AuthenticatedUser, @Body() body: { paused: boolean }) {
    await this.tenantModel.updateOne({ _id: new Types.ObjectId(user.tenantId) }, { paused: Boolean(body.paused) }).exec();
    await this.audit.record({
      tenantId: user.tenantId,
      actorId: user.userId,
      actorLabel: user.email,
      action: body.paused ? 'tenant.pause_all' : 'tenant.resume_all',
      entityType: 'Tenant',
      entityId: user.tenantId,
    });
    return { ok: true };
  }

  @Get('clients')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR')
  clients(@CurrentUser() user: AuthenticatedUser) {
    return this.clientModel.find({ tenantId: new Types.ObjectId(user.tenantId) }).lean().exec();
  }

  @Post('clients')
  @Roles('OWNER', 'ADMIN')
  async createClient(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateClientDto) {
    const client = await this.clientModel.create({ tenantId: new Types.ObjectId(user.tenantId), name: dto.name });
    await this.audit.record({
      tenantId: user.tenantId,
      actorId: user.userId,
      actorLabel: user.email,
      action: 'client.create',
      entityType: 'Client',
      entityId: client._id.toString(),
      after: { name: dto.name },
    });
    return client;
  }
}
