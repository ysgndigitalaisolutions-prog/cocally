import { Module } from '@nestjs/common';
import { TelephonyModule } from '../telephony/telephony.module';
import { OpsController } from './ops.controller';

@Module({
  imports: [TelephonyModule],
  controllers: [OpsController],
})
export class OpsModule {}
