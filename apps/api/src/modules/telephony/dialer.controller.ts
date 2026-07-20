import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { DialerService } from './dialer.service';

/**
 * Read-only "why isn't it dialing?" view. Reports the same gates the dialer
 * enforces, so an ACTIVE-but-idle campaign always explains itself (e.g.
 * outside legal calling hours until 9am Melbourne) instead of looking broken.
 */
@Controller('dialer')
export class DialerController {
  constructor(
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    private readonly dialer: DialerService,
  ) {}

  @Get('status')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA', 'AGENT')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.dialer.statusForTenant(user.tenantId);
  }

  @Get('status/:campaignId')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA', 'AGENT')
  async statusFor(@CurrentUser() user: AuthenticatedUser, @Param('campaignId') campaignId: string) {
    if (!Types.ObjectId.isValid(campaignId)) throw new NotFoundException('Campaign not found');
    const campaign = await this.campaignModel
      .findOne({ _id: new Types.ObjectId(campaignId), tenantId: new Types.ObjectId(user.tenantId) })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    return this.dialer.describeStatus(campaign);
  }
}
