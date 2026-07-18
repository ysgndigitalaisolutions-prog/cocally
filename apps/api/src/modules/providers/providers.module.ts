import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PronunciationLexicon,
  PronunciationLexiconSchema,
  ProviderOverride,
  ProviderOverrideSchema,
  ProviderSecret,
  ProviderSecretSchema,
} from '../../schemas/provider.schema';
import { AuditModule } from '../audit/audit.module';
import { PalService } from './pal.service';
import { ProvidersController } from './providers.controller';
import { VaultService } from './vault.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ProviderOverride.name, schema: ProviderOverrideSchema },
      { name: ProviderSecret.name, schema: ProviderSecretSchema },
      { name: PronunciationLexicon.name, schema: PronunciationLexiconSchema },
    ]),
    AuditModule,
  ],
  controllers: [ProvidersController],
  providers: [PalService, VaultService],
  exports: [PalService, VaultService],
})
export class ProvidersModule {}
