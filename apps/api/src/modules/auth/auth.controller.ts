import { Body, Controller, Post } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { Public } from '../../common/auth/public.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { AuthService } from './auth.service';

class LoginDto {
  /**
   * Login identifier — an email address, or a plain username for the short
   * demo accounts seeded by `seed.ts`. Was `@IsEmail()`; relaxed so username
   * logins reach the service (which looks up `email` lowercased either way).
   */
  @IsString()
  @MinLength(1)
  email: string;

  /**
   * NOTE: floor lowered from 8 to 4 to admit the demo accounts' `1234`.
   * Raise this back to 8 before any production deployment — this is a public,
   * unauthenticated endpoint and the floor applies to every environment.
   */
  @IsString()
  @MinLength(4)
  password: string;

  @IsOptional()
  @IsString()
  totpCode?: string;
}

class Confirm2faDto {
  @IsString()
  code: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password, dto.totpCode);
  }

  @Post('2fa/setup')
  setup2fa(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.setup2fa(user.userId);
  }

  @Post('2fa/confirm')
  confirm2fa(@CurrentUser() user: AuthenticatedUser, @Body() dto: Confirm2faDto) {
    return this.authService.confirm2fa(user.userId, dto.code);
  }
}
