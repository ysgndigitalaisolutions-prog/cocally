import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { ProviderSecret, ProviderSecretDocument } from '../../schemas/provider.schema';
import type { ProviderCredentials } from './types';

/**
 * Secrets vault per PAL-12: per-tenant provider credentials, AES-256-GCM
 * encrypted at rest, never exposed to the client (read paths return
 * existence only). Each provider stores whatever fields its credential
 * schema declares — a plain API key, key+region, base URL, or a
 * service-account JSON — encrypted together as one JSON blob.
 */
@Injectable()
export class VaultService {
  private readonly key = Buffer.from(config.vaultKey, 'hex');

  constructor(@InjectModel(ProviderSecret.name) private readonly secretModel: Model<ProviderSecretDocument>) {}

  async setCredentials(tenantId: string, providerId: string, credentials: ProviderCredentials): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = JSON.stringify(credentials);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    await this.secretModel.updateOne(
      { tenantId: new Types.ObjectId(tenantId), providerId },
      {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
      },
      { upsert: true },
    );
  }

  /**
   * Returns the tenant's credential bundle for a provider, falling back to
   * platform env keys (shaped as {apiKey}) so dev/pilot works without
   * per-tenant configuration.
   */
  async getCredentials(tenantId: string, providerId: string): Promise<ProviderCredentials | undefined> {
    const doc = await this.secretModel
      .findOne({ tenantId: new Types.ObjectId(tenantId), providerId })
      .select('+ciphertext +iv +authTag')
      .lean()
      .exec();
    if (doc) {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(doc.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(doc.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(doc.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      try {
        return JSON.parse(plaintext) as ProviderCredentials;
      } catch {
        // Pre-multi-field records stored the raw key string; migrate shape on read.
        return { apiKey: plaintext };
      }
    }
    const envKeys: Record<string, string | undefined> = {
      elevenlabs: config.providerKeys.elevenlabs,
      deepgram: config.providerKeys.deepgram,
      openai: config.providerKeys.openai,
      'openai-whisper': config.providerKeys.openai,
      anthropic: config.providerKeys.anthropic,
      google: config.providerKeys.google,
      'google-stt': config.providerKeys.google,
      'google-tts': config.providerKeys.google,
      gemini: config.providerKeys.google,
    };
    const envKey = envKeys[providerId];
    return envKey ? { apiKey: envKey } : undefined;
  }

  async hasCredentials(tenantId: string, providerId: string): Promise<boolean> {
    const count = await this.secretModel
      .countDocuments({ tenantId: new Types.ObjectId(tenantId), providerId })
      .exec();
    return count > 0;
  }

  /** Provider ids the tenant has stored credentials for (never the values). */
  async configuredProviderIds(tenantId: string): Promise<string[]> {
    const docs = await this.secretModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .select('providerId')
      .lean()
      .exec();
    return docs.map((d) => d.providerId);
  }
}
