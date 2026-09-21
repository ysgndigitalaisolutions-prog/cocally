import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { PredictiveDialerService } from './predictive-dialer.service';

/**
 * Read-only status for the human-agent ratio/adaptive dialer — same
 * "why isn't it dialing, and when does it change" contract as DialerController,
 * plus the live ratio and rolling abandon-rate the governor is steering off.
 * Config changes (enable, ratio, method, caps) go through the existing
 * campaign PATCH endpoint — `predictiveDialing` is an editable field there.
 */
@Controller('predictive-dialer')
export class PredictiveDialerController {
  constructor(
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    private readonly predictive: PredictiveDialerService,
  ) {}

  @Get('status')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA', 'AGENT')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.predictive.statusForTenant(user.tenantId);
  }

  @Get('status/:campaignId')
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA', 'AGENT')
  async statusFor(@CurrentUser() user: AuthenticatedUser, @Param('campaignId') campaignId: string) {
    if (!Types.ObjectId.isValid(campaignId)) throw new NotFoundException('Campaign not found');
    const campaign = await this.campaignModel
      .findOne({ _id: new Types.ObjectId(campaignId), tenantId: new Types.ObjectId(user.tenantId) })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    return this.predictive.describeStatus(campaign);
  }
}
