import { createHmac, randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import type { WebhookEvent } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import {
  WebhookDelivery,
  WebhookDeliveryDocument,
  WebhookSubscription,
  WebhookSubscriptionDocument,
} from '../../schemas/webhook.schema';

/**
 * Webhooks per PLAT-04: HMAC-SHA256 signed deliveries with exponential
 * retry. dispatch() enqueues; the worker drains pending deliveries.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectModel(WebhookSubscription.name) private readonly subscriptionModel: Model<WebhookSubscriptionDocument>,
    @InjectModel(WebhookDelivery.name) private readonly deliveryModel: Model<WebhookDeliveryDocument>,
  ) {}

  async createSubscription(tenantId: string, input: { url: string; events: WebhookEvent[]; clientId?: string }) {
    const secret = randomBytes(24).toString('hex');
    const subscription = await this.subscriptionModel.create({
      tenantId: new Types.ObjectId(tenantId),
      clientId: input.clientId ? new Types.ObjectId(input.clientId) : undefined,
      url: input.url,
      events: input.events,
      secret,
    });
    // Secret shown once at creation.
    return { id: subscription._id.toString(), url: input.url, events: input.events, secret };
  }

  async list(tenantId: string) {
    return this.subscriptionModel.find({ tenantId: new Types.ObjectId(tenantId) }).lean().exec();
  }

  async dispatch(tenantId: string, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
    const subscriptions = await this.subscriptionModel
      .find({ tenantId: new Types.ObjectId(tenantId), events: event, active: true })
      .lean()
      .exec();
    for (const subscription of subscriptions) {
      await this.deliveryModel.create({
        tenantId: new Types.ObjectId(tenantId),
        subscriptionId: subscription._id,
        event,
        payload: { event, at: new Date().toISOString(), data: payload },
        nextRetryAt: new Date(),
      });
    }
  }

  @Interval(10_000)
  async drainQueue(): Promise<void> {
    const due = await this.deliveryModel
      .find({ status: 'PENDING', nextRetryAt: { $lte: new Date() } })
      .limit(20)
      .exec();

    for (const delivery of due) {
      const subscription = await this.subscriptionModel
        .findById(delivery.subscriptionId)
        .select('+secret')
        .lean()
        .exec();
      if (!subscription || !subscription.active) {
        delivery.status = 'FAILED';
        delivery.lastError = 'subscription missing or inactive';
        await delivery.save();
        continue;
      }

      const body = JSON.stringify(delivery.payload);
      const signature = createHmac('sha256', subscription.secret).update(body).digest('hex');
      try {
        const response = await fetch(subscription.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cocally-event': delivery.event,
            'x-cocally-signature': `sha256=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        delivery.status = 'DELIVERED';
        delivery.deliveredAt = new Date();
      } catch (err) {
        delivery.attempts += 1;
        delivery.lastError = (err as Error).message;
        if (delivery.attempts >= 6) {
          delivery.status = 'FAILED';
        } else {
          // Exponential backoff: 1m, 4m, 16m, ~1h, ~4h.
          delivery.nextRetryAt = new Date(Date.now() + 60_000 * 4 ** (delivery.attempts - 1));
        }
      }
      await delivery.save();
    }
  }
}
