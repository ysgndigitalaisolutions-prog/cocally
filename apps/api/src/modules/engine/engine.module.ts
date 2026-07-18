import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { ProvidersModule } from '../providers/providers.module';
import { FlowExecutorService } from './flow-executor.service';

@Module({
  imports: [ProvidersModule, LeadsModule],
  providers: [FlowExecutorService],
  exports: [FlowExecutorService],
})
export class EngineModule {}
