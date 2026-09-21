import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { IsString, IsOptional, MinLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AllowWithout2fa, Public } from '../../common/auth/public.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { AuthService, type RequestContext } from './auth.service';

class LoginDto {
  /** Phone number in any spelling, or an email/username for legacy accounts. */
  @IsString()
  @MinLength(1)
  identifier: string;

  @IsString()
  @MinLength(1)
  password: string;

  @IsOptional()
  @IsString()
  totpCode?: string;
}

class AcceptInviteDto {
  @IsString()
  @MinLength(20)
  token: string;

  @IsString()
  password: string;
}

class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  newPassword: string;
}

class Confirm2faDto {
  @IsString()
  code: string;
}

const ALL_ROLES = ['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT', 'QA', 'API_CLIENT'] as const;

function ctxOf(req: Request): RequestContext {
  return { ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 200) };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto.identifier, dto.password, dto.totpCode, ctxOf(req));
  }

  /** Own profile, including whether TOTP setup is still outstanding. */
  @Get('me')
  @Roles(...ALL_ROLES)
  @AllowWithout2fa()
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.profile(user.userId);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('invite/:token')
  inspectInvite(@Param('token') token: string) {
    return this.authService.inspectInvite(token);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('invite/accept')
  acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    return this.authService.acceptInvite(dto.token, dto.password, ctxOf(req));
  }

  @Post('password')
  @Roles(...ALL_ROLES)
  @AllowWithout2fa()
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    return this.authService.changePassword(user.userId, dto.currentPassword, dto.newPassword, ctxOf(req));
  }

  @Post('2fa/setup')
  @Roles(...ALL_ROLES)
  @AllowWithout2fa()
  setup2fa(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.setup2fa(user.userId);
  }

  @Post('2fa/confirm')
  @Roles(...ALL_ROLES)
  @AllowWithout2fa()
  confirm2fa(@CurrentUser() user: AuthenticatedUser, @Body() dto: Confirm2faDto, @Req() req: Request) {
    return this.authService.confirm2fa(user.userId, dto.code, ctxOf(req));
  }
}
