import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** Scoped API keys per PLAT-04 for end-client CRMs. */
@Schema({ timestamps: true })
export class ApiKey {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Client' })
  clientId?: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  /** SHA-256 hash of the key; plaintext shown once at creation. */
  @Prop({ required: true, unique: true })
  keyHash: string;

  /** Key id prefix for identification, e.g. "ck_live_ab12". */
  @Prop({ required: true })
  prefix: string;

  @Prop({ type: [String], default: [] })
  scopes: string[];

  @Prop()
  lastUsedAt?: Date;

  @Prop({ default: true })
  active: boolean;
}

export type ApiKeyDocument = HydratedDocument<ApiKey>;
export const ApiKeySchema = SchemaFactory.createForClass(ApiKey);
