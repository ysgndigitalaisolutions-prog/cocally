import { Body, Controller, Get, Post } from '@nestjs/common';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@cocally/shared';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString, IsUrl } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { WebhooksService } from './webhooks.service';

class CreateSubscriptionDto {
  @IsUrl({ require_tld: false })
  url: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events: WebhookEvent[];

  @IsOptional()
  @IsString()
  clientId?: string;
}

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @Roles('ADMIN')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.webhooks.list(user.tenantId);
  }

  @Post()
  @Roles('ADMIN')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSubscriptionDto) {
    return this.webhooks.createSubscription(user.tenantId, dto);
  }
}
