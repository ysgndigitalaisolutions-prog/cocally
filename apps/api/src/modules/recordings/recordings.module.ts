import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Recording, RecordingSchema } from '../../schemas/recording.schema';
import { Tenant, TenantSchema } from '../../schemas/tenant.schema';
import { AuditModule } from '../audit/audit.module';
import { RecordingsController } from './recordings.controller';
import { RecordingsService } from './recordings.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Recording.name, schema: RecordingSchema },
      { name: Tenant.name, schema: TenantSchema },
    ]),
    AuditModule,
  ],
  controllers: [RecordingsController],
  providers: [RecordingsService],
  exports: [RecordingsService],
})
export class RecordingsModule {}
