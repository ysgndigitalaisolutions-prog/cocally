import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Campaign, CampaignSchema } from '../../schemas/campaign.schema';
import {
  Lead,
  LeadImport,
  LeadImportSchema,
  LeadList,
  LeadListSchema,
  LeadNote,
  LeadNoteSchema,
  LeadSchema,
} from '../../schemas/lead.schema';
import { Appointment, AppointmentSchema, Callback, CallbackSchema } from '../../schemas/appointment.schema';
import { User, UserSchema } from '../../schemas/user.schema';
import { DncWashRecord, DncWashRecordSchema, SuppressionEntry, SuppressionEntrySchema } from '../../schemas/suppression.schema';
import { AuditModule } from '../audit/audit.module';
import { CountryPacksModule } from '../country-packs/country-packs.module';
import { AssignmentService } from './assignment.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { SchedulingService } from './scheduling.service';
import { SuppressionService } from './suppression.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Lead.name, schema: LeadSchema },
      { name: LeadList.name, schema: LeadListSchema },
      { name: LeadImport.name, schema: LeadImportSchema },
      { name: LeadNote.name, schema: LeadNoteSchema },
      { name: SuppressionEntry.name, schema: SuppressionEntrySchema },
      { name: DncWashRecord.name, schema: DncWashRecordSchema },
      { name: Campaign.name, schema: CampaignSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Callback.name, schema: CallbackSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AuditModule,
    CountryPacksModule,
  ],
  controllers: [LeadsController],
  providers: [LeadsService, SuppressionService, AssignmentService, SchedulingService],
  exports: [LeadsService, SuppressionService, AssignmentService, SchedulingService],
})
export class LeadsModule {}
