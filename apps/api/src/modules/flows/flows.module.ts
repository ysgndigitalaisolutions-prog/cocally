import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Flow, FlowSchema, FlowVersion, FlowVersionSchema, PromptAsset, PromptAssetSchema } from '../../schemas/flow.schema';
import { AuditModule } from '../audit/audit.module';
import { CountryPacksModule } from '../country-packs/country-packs.module';
import { EngineModule } from '../engine/engine.module';
import { ProvidersModule } from '../providers/providers.module';
import { FlowGeneratorService } from './flow-generator.service';
import { FlowsController } from './flows.controller';
import { FlowsService } from './flows.service';
import { SimSessionService } from './sim-session.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Flow.name, schema: FlowSchema },
      { name: FlowVersion.name, schema: FlowVersionSchema },
      { name: PromptAsset.name, schema: PromptAssetSchema },
    ]),
    AuditModule,
    CountryPacksModule,
    EngineModule,
    ProvidersModule,
  ],
  controllers: [FlowsController],
  providers: [FlowsService, SimSessionService, FlowGeneratorService],
  exports: [FlowsService],
})
export class FlowsModule {}
