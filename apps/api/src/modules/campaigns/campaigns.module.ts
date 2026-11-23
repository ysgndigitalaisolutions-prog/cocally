import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import { FlowVersion, FlowVersionSchema } from '../../schemas/flow.schema';
import { Client, ClientSchema } from '../../schemas/tenant.schema';
import { User, UserSchema } from '../../schemas/user.schema';
import { CliNumber, CliNumberSchema } from '../../schemas/cli-number.schema';
import { AuditModule } from '../audit/audit.module';
import { CountryPacksModule } from '../country-packs/country-packs.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campaign.name, schema: CampaignSchema },
      { name: Client.name, schema: ClientSchema },
      { name: FlowVersion.name, schema: FlowVersionSchema },
      { name: User.name, schema: UserSchema },
      { name: CliNumber.name, schema: CliNumberSchema },
    ]),
    AuditModule,
    CountryPacksModule,
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
