import { Controller, Get, Param } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { CountryPacksService } from './country-packs.service';

@Controller('country-packs')
export class CountryPacksController {
  constructor(private readonly packs: CountryPacksService) {}

  @Get()
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  list() {
    return this.packs.list();
  }

  @Get(':code')
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  get(@Param('code') code: string) {
    return this.packs.getByCode(code);
  }
}
