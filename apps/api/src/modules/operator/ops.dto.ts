import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ROLES, type Role } from '@cocally/shared';
import { ADVANCE_RULES, TTS_PROVIDERS, type AdvanceRule, type TtsProvider } from '../../schemas/tenant.schema';
import { TENANT_REGIONS } from './ops-tenants.service';

export class VoiceDto {
  @IsIn(TTS_PROVIDERS)
  provider: TtsProvider;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  voiceId?: string;
}

export class TierDto {
  @IsNumber()
  @Min(0)
  fromMinutes: number;

  @IsNumber()
  @Min(0)
  @Max(1000)
  aiPerMinInr: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  perDialInr: number;
}

export class BillToDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(20) gstin?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
}

export class BillingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => TierDto)
  tiers: TierDto[];

  @IsNumber()
  @Min(0)
  @Max(10_000_000)
  monthlyAdvanceInr: number;

  @IsIn(ADVANCE_RULES)
  advanceRule: AdvanceRule;

  @IsNumber()
  @Min(0)
  @Max(28)
  gstPercent: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => BillToDto)
  billTo?: BillToDto;
}

export class MoneyDto {
  @IsNumber()
  amountInr: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsDateString()
  at?: string;
}

export class MonthDto {
  @Matches(/^\d{4}-\d{2}$/)
  month: string;
}

export class IssueDto {
  @IsOptional() @IsInt() @Min(0) @Max(90) dueDays?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class PaidDto {
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
}

export class VoidDto {
  @IsString() @MaxLength(300) reason: string;
}

export class SellerDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(20) gstin?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) paymentDetails?: string;
}

export class RateCardDto {
  @IsOptional() @IsNumber() @Min(0) livekitAgentPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) livekitSipPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) livekitWebrtcPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) sttPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) llmPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) ttsPer1kChars?: number;
  @IsOptional() @IsNumber() @Min(0) recordingPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) telcoPerMin?: number;
  @IsOptional() @IsNumber() @Min(0) fixedMonthlyUsd?: number;
  @IsOptional() @IsNumber() @Min(1) inrPerUsd?: number;
}


export class OwnerDto {
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  @IsString() @MinLength(6) @MaxLength(20) phone: string;
  @IsOptional() @IsEmail() email?: string;
}

export class CreateTenantDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @Matches(/^[a-z0-9-]{3,40}$/, { message: 'Short name must be 3–40 characters of a–z, 0–9 and -' }) slug: string;
  @IsIn(TENANT_REGIONS) region: (typeof TENANT_REGIONS)[number];
  @IsOptional() @IsString() @MaxLength(120) clientName?: string;
  @ValidateNested() @Type(() => OwnerDto) owner: OwnerDto;
  @IsOptional() @ValidateNested() @Type(() => BillingDto) billing?: BillingDto;
  @IsOptional() @ValidateNested() @Type(() => VoiceDto) voice?: VoiceDto;
  @IsOptional() @IsInt() @Min(30) @Max(3650) retentionDays?: number;
  @IsOptional() @IsInt() @Min(0) dailyDialQuota?: number;
}

export class UpdateTenantDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() paused?: boolean;
  @IsOptional() @IsInt() @Min(0) dailyDialQuota?: number;
  @IsOptional() @IsInt() @Min(30) @Max(3650) retentionDays?: number;
  /** null resets to the worker's default voice. */
  @IsOptional() @ValidateNested() @Type(() => VoiceDto) voice?: VoiceDto | null;
  @IsOptional() @ValidateNested() @Type(() => BillingDto) billing?: BillingDto;
}

export class InviteUserDto {
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  @IsString() @MinLength(6) @MaxLength(20) phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsArray() @ArrayMinSize(1) @IsIn(ROLES, { each: true }) roles: Role[];
}

export class RolesDto {
  @IsArray() @ArrayMinSize(1) @IsIn(ROLES, { each: true }) roles: Role[];
}

export class ActiveDto {
  @IsBoolean() active: boolean;
}

export class CreateOperatorDto {
  @IsEmail() email: string;
  @IsString() @MinLength(2) @MaxLength(100) name: string;
}
