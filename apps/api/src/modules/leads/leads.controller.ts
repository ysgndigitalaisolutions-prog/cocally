import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { LeadState } from '@cocally/shared';
import { IsArray, IsBoolean, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { Types } from 'mongoose';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { AssignmentService, type AssignStrategy } from './assignment.service';
import { LeadsService, type ColumnMapping } from './leads.service';
import { SchedulingService } from './scheduling.service';
import { SuppressionService } from './suppression.service';

class CreateListDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  campaignId?: string;

  @IsOptional()
  @IsNumber()
  priority?: number;
}

class ImportCsvDto {
  @IsOptional()
  @IsString()
  listId?: string;

  /** Preferred: import straight into a campaign; its list is managed automatically. */
  @IsOptional()
  @IsString()
  campaignId?: string;

  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsString()
  @IsNotEmpty()
  csvContent: string;

  /** Provenance stamped on every imported lead (list vendor, campaign source…). */
  @IsOptional()
  @IsString()
  source?: string;

  @IsObject()
  mapping: ColumnMapping;
}

class OptOutDto {
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  source: string;
}

class UpdateLeadDto {
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() suburb?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() postcode?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) altPhones?: string[];
  @IsOptional() @IsObject() custom?: Record<string, string>;
}

class SetStateDto {
  @IsString() @IsNotEmpty() state: LeadState;
  @IsString() @IsNotEmpty() reason: string;
}

class NoteDto {
  @IsString() @IsNotEmpty() text: string;
}

class TagDto {
  @IsArray() @IsString({ each: true }) leadIds: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) add?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) remove?: string[];
}

class ReassignDto {
  @IsArray() @IsString({ each: true }) leadIds: string[];
  /** null returns the leads to the shared pool. */
  @IsOptional() @IsString() toAgentId?: string | null;
}

class DistributeDto {
  @IsArray() @IsString({ each: true }) campaignIds: string[];
  @IsArray() @IsString({ each: true }) agentIds: string[];
  @IsNumber() perAgent: number;
  @IsOptional() @IsString() strategy?: AssignStrategy;
}

class RecycleDto {
  @IsString() @IsNotEmpty() campaignId: string;
  @IsArray() @IsString({ each: true }) fromStates: LeadState[];
  @IsOptional() @IsNumber() olderThanDays?: number;
  @IsOptional() @IsBoolean() resetAttempts?: boolean;
}

class ScheduleCallbackDto {
  @IsString() @IsNotEmpty() leadId: string;
  @IsString() @IsNotEmpty() campaignId: string;
  @IsString() @IsNotEmpty() dueAt: string;
  @IsOptional() @IsString() handler?: 'AI' | 'HUMAN';
  @IsOptional() @IsString() preferredAgentId?: string;
  @IsOptional() @IsString() notes?: string;
}

class BookAppointmentDto {
  @IsString() @IsNotEmpty() clientId: string;
  @IsString() @IsNotEmpty() leadId: string;
  @IsString() @IsNotEmpty() startsAt: string;
  @IsOptional() @IsString() callId?: string;
  @IsOptional() @IsNumber() durationMinutes?: number;
  @IsOptional() @IsString() slotKey?: string;
  @IsOptional() @IsString() notes?: string;
}

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly suppression: SuppressionService,
    private readonly assignment: AssignmentService,
    private readonly scheduling: SchedulingService,
  ) {}

  @Get('lists')
  @Roles('ADMIN', 'SUPERVISOR')
  lists(@CurrentUser() user: AuthenticatedUser) {
    return this.leadsService.lists(user.tenantId);
  }

  @Post('lists')
  @Roles('ADMIN')
  createList(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateListDto) {
    return this.leadsService.createList(user.tenantId, dto);
  }

  @Post('import')
  @Roles('ADMIN')
  importCsv(@CurrentUser() user: AuthenticatedUser, @Body() dto: ImportCsvDto) {
    return this.leadsService.importCsv(user.tenantId, { id: user.userId, label: user.email }, dto);
  }

  @Post('opt-out')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT')
  optOut(@CurrentUser() user: AuthenticatedUser, @Body() dto: OptOutDto) {
    return this.suppression.optOut(user.tenantId, dto.phone, `${dto.source} (by ${user.email})`);
  }

  @Get('campaign/:campaignId')
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  byCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('campaignId') campaignId: string,
    @Query('state') state?: LeadState,
    @Query('limit') limit?: string,
  ) {
    return this.leadsService.listByCampaign(user.tenantId, campaignId, state, limit ? Number(limit) : undefined);
  }

  /** Paged, searchable lead browse — the only way to work past the first page of a 100k book. */
  @Get('search')
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Query('campaignId') campaignId?: string,
    @Query('listId') listId?: string,
    @Query('state') state?: LeadState,
    @Query('ownerId') ownerId?: string,
    @Query('tag') tag?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.leadsService.search(user.tenantId, {
      campaignId,
      listId,
      state,
      ownerId,
      tag,
      q,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── Callbacks ────────────────────────────────────────────────────────────

  /** The signed-in agent's callback book. */
  @Get('callbacks/mine')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT')
  myCallbacks(
    @CurrentUser() user: AuthenticatedUser,
    @Query('withinHours') withinHours?: string,
    @Query('includeUnassigned') includeUnassigned?: string,
  ) {
    return this.scheduling.dueCallbacks(user.tenantId, user.userId, {
      withinHours: withinHours ? Number(withinHours) : undefined,
      includeUnassigned: includeUnassigned === 'true',
    });
  }

  /** Floor-wide missed promises — a daily supervisor exception report. */
  @Get('callbacks/overdue')
  @Roles('ADMIN', 'SUPERVISOR')
  overdueCallbacks(@CurrentUser() user: AuthenticatedUser) {
    return this.scheduling.overdueCallbacks(user.tenantId);
  }

  @Post('callbacks')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT')
  scheduleCallback(@CurrentUser() user: AuthenticatedUser, @Body() dto: ScheduleCallbackDto) {
    return this.scheduling.scheduleCallback({
      tenantId: user.tenantId,
      leadId: dto.leadId,
      campaignId: dto.campaignId,
      dueAt: new Date(dto.dueAt),
      handler: dto.handler,
      // Default the promise to whoever made it — the customer expects that voice.
      preferredAgentId: dto.preferredAgentId ?? user.userId,
      notes: dto.notes,
    });
  }

  @Post('callbacks/:id/complete')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT')
  completeCallback(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.scheduling.completeCallback(user.tenantId, id);
  }

  // ── Appointments ─────────────────────────────────────────────────────────

  @Get('appointments')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT', 'QA')
  appointments(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    return this.scheduling.appointments(user.tenantId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      status,
    });
  }

  @Post('appointments')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT')
  bookAppointment(@CurrentUser() user: AuthenticatedUser, @Body() dto: BookAppointmentDto) {
    return this.scheduling.bookAppointment({
      tenantId: user.tenantId,
      clientId: dto.clientId,
      leadId: dto.leadId,
      callId: dto.callId,
      startsAt: new Date(dto.startsAt),
      durationMinutes: dto.durationMinutes,
      slotKey: dto.slotKey,
      notes: dto.notes,
    });
  }

  // ── Assignment ───────────────────────────────────────────────────────────

  /** Per-agent worklist depth, so a supervisor can see who is starving. */
  @Get('assignment/load')
  @Roles('ADMIN', 'SUPERVISOR')
  assignmentLoad(@CurrentUser() user: AuthenticatedUser) {
    return this.assignment.loadByAgent(user.tenantId);
  }

  @Post('assignment/reassign')
  @Roles('ADMIN', 'SUPERVISOR')
  reassign(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReassignDto) {
    return this.assignment
      .reassign(user.tenantId, dto.leadIds, dto.toAgentId ?? null)
      .then((moved) => ({ moved }));
  }

  @Post('assignment/distribute')
  @Roles('ADMIN', 'SUPERVISOR')
  distribute(@CurrentUser() user: AuthenticatedUser, @Body() dto: DistributeDto) {
    return this.assignment.distribute(
      user.tenantId,
      dto.campaignIds.filter((c) => Types.ObjectId.isValid(c)).map((c) => new Types.ObjectId(c)),
      dto.agentIds,
      dto.perAgent,
      dto.strategy,
    );
  }

  @Post('recycle')
  @Roles('ADMIN', 'SUPERVISOR')
  recycle(@CurrentUser() user: AuthenticatedUser, @Body() dto: RecycleDto) {
    return this.leadsService
      .recycle(user.tenantId, { id: user.userId, label: user.email }, dto)
      .then((recycled) => ({ recycled }));
  }

  @Post('tag')
  @Roles('ADMIN', 'SUPERVISOR')
  tag(@CurrentUser() user: AuthenticatedUser, @Body() dto: TagDto) {
    return this.leadsService
      .tag(user.tenantId, dto.leadIds, dto.add ?? [], dto.remove ?? [])
      .then((modified) => ({ modified }));
  }

  // ── Single lead ──────────────────────────────────────────────────────────

  @Get(':id')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT', 'QA')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.get(user.tenantId, id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateLeadDto) {
    return this.leadsService.update(user.tenantId, id, { id: user.userId, label: user.email }, dto);
  }

  @Post(':id/state')
  @Roles('ADMIN', 'SUPERVISOR')
  setState(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SetStateDto) {
    return this.leadsService.setState(
      user.tenantId,
      id,
      { id: user.userId, label: user.email },
      dto.state,
      dto.reason,
    );
  }

  @Get(':id/notes')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT', 'QA')
  notes(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.notes(user.tenantId, id);
  }

  @Post(':id/notes')
  @Roles('ADMIN', 'SUPERVISOR', 'AGENT')
  addNote(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.leadsService.addNote(user.tenantId, id, { id: user.userId, label: user.email }, dto.text);
  }
}
