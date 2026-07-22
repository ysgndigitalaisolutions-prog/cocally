import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Call, CallSchema } from '../../schemas/call.schema';
import { User, UserSchema } from '../../schemas/user.schema';
import { RecordingsModule } from '../recordings/recordings.module';
import { TelephonyModule } from '../telephony/telephony.module';
import { MaintenanceService } from './maintenance.service';
import { OpsController } from './ops.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Call.name, schema: CallSchema },
      { name: User.name, schema: UserSchema },
    ]),
    TelephonyModule,
    RecordingsModule,
  ],
  controllers: [OpsController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class OpsModule {}
