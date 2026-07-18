import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CountryPack, CountryPackSchema } from '../../schemas/country-pack.schema';
import { CountryPacksController } from './country-packs.controller';
import { CountryPacksService } from './country-packs.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: CountryPack.name, schema: CountryPackSchema }])],
  controllers: [CountryPacksController],
  providers: [CountryPacksService],
  exports: [CountryPacksService],
})
export class CountryPacksModule {}
