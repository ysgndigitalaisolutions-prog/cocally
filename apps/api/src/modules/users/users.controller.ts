import { Body, Controller, ForbiddenException, Get, Param, Patch, Post } from '@nestjs/common';
import { ROLES, type Role } from '@cocally/shared';
import { ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthService } from '../auth/auth.service';
import { UsersService } from './users.service';

class InviteUserDto {
  @IsString()
  @MinLength(6)
  phone: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ROLES, { each: true })
  roles: Role[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];
}

class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ROLES, { each: true })
  roles?: Role[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** Only an OWNER may grant the OWNER role; ADMIN manages everyone else. */
function assertCanGrant(actor: AuthenticatedUser, roles?: Role[]) {
  if (roles?.includes('OWNER') && !actor.roles.includes('OWNER')) {
    throw new ForbiddenException('Only an owner can grant the OWNER role');
  }
}

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  /** QA needs the roster to filter calls by the agent who handled them. */
  @Get()
  @Roles('OWNER', 'ADMIN', 'SUPERVISOR', 'QA')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.list(user.tenantId);
  }

  /** Creates the account and returns a one-time invite link to send to the person. */
  @Post()
  @Roles('OWNER', 'ADMIN')
  invite(@CurrentUser() user: AuthenticatedUser, @Body() dto: InviteUserDto) {
    assertCanGrant(user, dto.roles);
    return this.usersService.invite(user.tenantId, { id: user.userId, label: user.email }, dto);
  }

  /** New invite link (no password yet) or password-reset link (password set). */
  @Post(':id/link')
  @Roles('OWNER', 'ADMIN')
  reissueLink(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.reissueLink(user.tenantId, { id: user.userId, label: user.email }, id);
  }

  /** Clears a lost authenticator; the user re-enrols at next login. */
  @Post(':id/2fa/reset')
  @Roles('OWNER', 'ADMIN')
  async reset2fa(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    await this.usersService.assertMayManageId(user.tenantId, user.userId, id);
    await this.authService.reset2fa(user.tenantId, id, { id: user.userId, label: user.email });
    return { ok: true };
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    assertCanGrant(user, dto.roles);
    return this.usersService.update(user.tenantId, { id: user.userId, label: user.email }, id, dto);
  }
}
