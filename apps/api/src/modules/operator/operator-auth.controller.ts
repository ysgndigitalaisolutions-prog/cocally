import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/auth/public.decorator';
import { CurrentOperator, OperatorAuthGuard, type AuthenticatedOperator } from './operator-auth.guard';
import { OperatorAuthService } from './operator-auth.service';

class OpsLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;

  @IsOptional()
  @IsString()
  @Length(6, 6)
  code?: string;
}

class EnrolDto {
  @IsString()
  enrolToken: string;

  @IsString()
  @Length(6, 6)
  code: string;
}

class AcceptDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password: string;
}

class PasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(12)
  @MaxLength(200)
  newPassword: string;
}

/**
 * Ops console sign-in. `@Public()` only lifts the TENANT guards; the routes
 * that need a session carry OperatorAuthGuard themselves.
 */
@Public()
@Controller('operator/auth')
export class OperatorAuthController {
  constructor(private readonly auth: OperatorAuthService) {}

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('login')
  login(@Body() dto: OpsLoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, dto.code, req.ip);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('enrol')
  enrol(@Body() dto: EnrolDto, @Req() req: Request) {
    return this.auth.confirmEnrolment(dto.enrolToken, dto.code, req.ip);
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('invite/:token')
  inspect(@Param('token') token: string) {
    return this.auth.inspectInvite(token);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('invite/accept')
  accept(@Body() dto: AcceptDto, @Req() req: Request) {
    return this.auth.acceptInvite(dto.token, dto.password, req.ip);
  }

  @UseGuards(OperatorAuthGuard)
  @Get('me')
  me(@CurrentOperator() op: AuthenticatedOperator) {
    return this.auth.me(op.operatorId);
  }

  @UseGuards(OperatorAuthGuard)
  @Post('password')
  password(@CurrentOperator() op: AuthenticatedOperator, @Body() dto: PasswordDto, @Req() req: Request) {
    return this.auth.changePassword(op, dto.currentPassword, dto.newPassword, req.ip);
  }

  @UseGuards(OperatorAuthGuard)
  @Post('sign-out-everywhere')
  signOutEverywhere(@CurrentOperator() op: AuthenticatedOperator) {
    return this.auth.signOutEverywhere(op);
  }
}
