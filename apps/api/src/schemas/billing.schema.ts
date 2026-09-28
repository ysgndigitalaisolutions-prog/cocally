import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * The tenant's prepaid credit, as a ledger. The balance is the sum of
 * `amountInr` (before GST): advances add, usage applied on an issued invoice
 * subtracts. Entries are never edited or deleted — voiding an invoice adds a
 * REVERSAL — so the balance can always be explained line by line.
 */
export const CREDIT_KINDS = ['ADVANCE', 'USAGE', 'EXPIRY', 'ADJUSTMENT', 'REVERSAL'] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

@Schema({ timestamps: true })
export class CreditEntry {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: String, enum: CREDIT_KINDS, required: true })
  kind: CreditKind;

  /** Signed rupees: + adds credit, − uses it. */
  @Prop({ required: true })
  amountInr: number;

  /** When the money moved (advance received date; invoice issue date). */
  @Prop({ required: true })
  at: Date;

  /** Billing month this relates to, `YYYY-MM`. */
  @Prop()
  period?: string;

  @Prop({ type: Types.ObjectId, ref: 'Invoice' })
  invoiceId?: Types.ObjectId;

  /** Payment reference (UTR, cheque no.) or reason. */
  @Prop()
  note?: string;

  @Prop()
  createdBy?: string;
}

export type CreditEntryDocument = HydratedDocument<CreditEntry>;
export const CreditEntrySchema = SchemaFactory.createForClass(CreditEntry);
CreditEntrySchema.index({ tenantId: 1, at: -1 });

export interface InvoiceLine {
  label: string;
  quantity: number;
  unit: string;
  rateInr: number;
  amountInr: number;
}

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * A month's bill. Built as a DRAFT from the month's calls (and refreshable
 * until issued); issuing freezes it, numbers it and draws the advance down.
 */
@Schema({ timestamps: true })
export class Invoice {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  /** `YYYY-MM`, IST calendar month. */
  @Prop({ required: true })
  period: string;

  @Prop({ type: String, enum: INVOICE_STATUSES, default: 'DRAFT' })
  status: InvoiceStatus;

  /** e.g. CC-2026-0001, assigned on issue. */
  @Prop()
  number?: string;

  @Prop({ type: [Object], default: [] })
  lines: InvoiceLine[];

  /** Name of the price band applied ("Standard", "Growth"…). */
  @Prop()
  tierLabel?: string;

  @Prop({ required: true })
  subtotalInr: number;

  /** Prepaid credit applied against the subtotal. */
  @Prop({ default: 0 })
  advanceAppliedInr: number;

  @Prop({ required: true })
  taxableInr: number;

  @Prop({ required: true })
  gstPercent: number;

  @Prop({ required: true })
  gstInr: number;

  @Prop({ required: true })
  totalInr: number;

  /** Usage the lines were priced from, frozen with the invoice. */
  @Prop({ type: Object, default: {} })
  usage: Record<string, number>;

  @Prop({ type: Object, default: {} })
  billTo: { name?: string; address?: string; gstin?: string; email?: string };

  @Prop({ type: Object, default: {} })
  seller: Record<string, string | undefined>;

  @Prop()
  issuedAt?: Date;

  @Prop()
  dueAt?: Date;

  @Prop()
  paidAt?: Date;

  @Prop()
  paymentReference?: string;

  @Prop()
  notes?: string;
}

export type InvoiceDocument = HydratedDocument<Invoice>;
export const InvoiceSchema = SchemaFactory.createForClass(Invoice);
// One live (non-void) invoice per tenant per month.
InvoiceSchema.index(
  { tenantId: 1, period: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['DRAFT', 'ISSUED', 'PAID'] } } },
);
