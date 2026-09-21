import { Body, Controller, Get, Post } from '@nestjs/common';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';
import { Roles } from '../../common/auth/roles.decorator';
import { DncrWashService } from './dncr-wash.service';

class WashRequestDto {
  /**
   * E.164 numbers. Capped so a mis-pasted spreadsheet cannot spend the
   * account's entire credit balance in one request — bulk washing is the
   * scheduled sweep's job, this endpoint is for spot checks and re-washes.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  phones: string[];
}

/**
 * Manual controls over the ACMA Do Not Call Register wash.
 *
 * ADMIN-only: a wash costs money per number and the balance is a shared
 * resource across the whole tenant.
 */
@Controller('dncr')
export class DncrController {
  constructor(private readonly dncr: DncrWashService) {}

  /**
   * Why is the floor idle?
   *
   * `staleNumbers` is the answer nine times out of ten: those leads are being
   * rejected at dial time with DNC_WASH_STALE because their wash is missing or
   * has aged out. `enabled:false` is the other answer.
   */
  @Get('status')
  @Roles('ADMIN')
  status() {
    return this.dncr.status();
  }

  /** Remaining wash credits, straight from the register. */
  @Get('balance')
  @Roles('ADMIN')
  balance() {
    return this.dncr.getBalance();
  }

  /**
   * Wash a supplied list now.
   *
   * Returns the raw per-number verdicts. This deliberately does NOT write wash
   * records: attributing a wash to a tenant requires knowing which tenant owns
   * the number, and this endpoint accepts arbitrary strings. The scheduled
   * sweep is what persists results through SuppressionService.recordWash().
   */
  @Post('wash')
  @Roles('ADMIN')
  async wash(@Body() dto: WashRequestDto) {
    const results = await this.dncr.washNumbers(dto.phones);
    return {
      enabled: this.dncr.isEnabled(),
      requested: dto.phones.length,
      answered: results.size,
      results: Object.fromEntries(results),
    };
  }
}
