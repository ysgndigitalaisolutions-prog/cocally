import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AGENT_TRANSFER_KINDS, type AgentTransferKind } from '@cocally/shared';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { CallControlService } from './call-control.service';

class AgentTransferDto {
  @IsIn(AGENT_TRANSFER_KINDS)
  kind: AgentTransferKind;

  @IsString()
  @IsNotEmpty()
  toAgentId: string;

  /** Free-text context shown on the receiving agent's offer card. */
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

class ExternalTransferDto {
  /**
   * E.164, or a `sip:`/`tel:` URI for a direct SIP destination. Validated here
   * rather than at the carrier so a typo fails before we pay for a leg.
   */
  @IsString()
  @Matches(/^(\+[1-9]\d{6,14}|sip:.+|tel:.+)$/, {
    message: 'destination must be an E.164 number (+61...) or a sip:/tel: URI',
  })
  destination: string;
}

/**
 * Agent call control: hold, agent-to-agent transfer, external transfer.
 *
 * Everything here is agent-scoped — the service re-verifies that the caller is
 * actually on the call, so a stale tab or a copied callId cannot control
 * someone else's customer.
 */
@Controller('call-control')
export class CallControlController {
  constructor(private readonly control: CallControlService) {}

  /** Park the customer. The response carries the audio the browser must play. */
  @Post('calls/:id/hold')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  hold(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.control.hold(user.tenantId, user.userId, id);
  }

  @Post('calls/:id/resume')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.control.resume(user.tenantId, user.userId, id);
  }

  /** Offer this call to another agent (BLIND / WARM / CONFERENCE). */
  @Post('calls/:id/transfer/agent')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  offerAgentTransfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AgentTransferDto,
  ) {
    return this.control.offerAgentTransfer(user.tenantId, { id: user.userId, email: user.email }, id, {
      kind: dto.kind,
      toAgentId: dto.toAgentId,
      note: dto.note,
    });
  }

  /** Finish a warm consult — drops the introducing agent, un-parks the customer. */
  @Post('calls/:id/transfer/complete')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  completeWarmTransfer(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.control.completeWarmTransfer(user.tenantId, user.userId, id);
  }

  /** Blind-transfer off-platform. Bills a second carrier leg — see the service. */
  @Post('calls/:id/transfer/external')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  transferExternal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ExternalTransferDto,
  ) {
    return this.control.transferExternal(user.tenantId, user.userId, id, dto.destination);
  }

  /**
   * Receiving agent accepts. Deliberately distinct from
   * `POST /workspace/transfers/:id/accept`, which resolves an AI→agent offer
   * held by TransfersService — the two offer pools are unrelated and share no
   * ids, so collapsing the routes would make an id from one pool silently miss
   * in the other.
   */
  @Post('agent-transfers/:id/accept')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.control.acceptAgentTransfer(user.userId, user.email, id);
  }

  @Post('agent-transfers/:id/decline')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.control.declineAgentTransfer(user.userId, id);
  }

  /** The originating agent withdraws an offer still inside its accept window. */
  @Post('agent-transfers/:id/cancel')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.control.cancelAgentTransfer(user.userId, id);
  }
}

/**
 * `GET /workspace/me/current-call` lives on its own controller class rather
 * than on WorkspaceController because it needs LivekitService to mint a fresh
 * token, and LivekitService is a TelephonyModule provider while TelephonyModule
 * already imports WorkspaceModule. Injecting it the other way round would need
 * a `forwardRef` circular import for one endpoint. Nest is happy with two
 * controllers sharing a path prefix as long as the routes themselves differ.
 */
@Controller('workspace')
export class CurrentCallController {
  constructor(private readonly control: CallControlService) {}

  /** Rebuild the call bar after a reload. Returns null when the agent is idle. */
  @Get('me/current-call')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN', 'OWNER')
  currentCall(@CurrentUser() user: AuthenticatedUser) {
    return this.control.currentCall(user.tenantId, user.userId);
  }
}
