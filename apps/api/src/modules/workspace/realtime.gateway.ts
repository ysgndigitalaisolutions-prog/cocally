import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { FloorCallCard, PresenceState, Role, TransferCard, TranscriptSegment } from '@cocally/shared';
import type { Server, Socket } from 'socket.io';
import { PresenceService } from './presence.service';

interface SocketUser {
  userId: string;
  tenantId: string;
  roles: Role[];
}

/**
 * Workspace realtime channel per WS-01/02/03: presence, live floor feed,
 * transfer offers, transcript streaming. Auth is the same JWT as REST,
 * passed as socket handshake auth.token.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true }, namespace: '/ws' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly presence: PresenceService,
  ) {}

  private users = new Map<string, SocketUser>();

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = (socket.handshake.auth as { token?: string }).token ?? '';
      const payload = await this.jwtService.verifyAsync<{ sub: string; tenantId: string; roles: Role[] }>(token);
      const user: SocketUser = { userId: payload.sub, tenantId: payload.tenantId, roles: payload.roles };
      this.users.set(socket.id, user);
      await socket.join(`tenant:${user.tenantId}`);
      await socket.join(`user:${user.userId}`);
      this.logger.log(`socket connected user=${user.userId}`);
    } catch {
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const user = this.users.get(socket.id);
    this.users.delete(socket.id);
    if (user) {
      // If this was the agent's last socket, mark them offline per WS-01.
      const stillConnected = [...this.users.values()].some((u) => u.userId === user.userId);
      if (!stillConnected) {
        await this.presence.setPresence(user.userId, 'OFFLINE');
        this.emitToTenant(user.tenantId, 'presence.updated', { userId: user.userId, state: 'OFFLINE' });
      }
    }
  }

  @SubscribeMessage('presence.set')
  async onPresenceSet(socket: Socket, body: { state: PresenceState }): Promise<void> {
    const user = this.users.get(socket.id);
    if (!user) return;
    const allowed: PresenceState[] = ['AVAILABLE', 'WRAP_UP', 'BREAK', 'OFFLINE'];
    if (!allowed.includes(body.state)) return;
    await this.presence.setPresence(user.userId, body.state);
    this.emitToTenant(user.tenantId, 'presence.updated', { userId: user.userId, state: body.state });
  }

  /** Server-side emit helpers used by orchestrators. */
  emitToTenant(tenantId: string, event: string, payload: unknown): void {
    this.server.to(`tenant:${tenantId}`).emit(event, payload);
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  offerTransfer(agentId: string, card: TransferCard): void {
    this.emitToUser(agentId, 'transfer.offer', card);
  }

  cancelTransferOffer(agentId: string, transferId: string, reason: string): void {
    this.emitToUser(agentId, 'transfer.cancelled', { transferId, reason });
  }

  updateFloorCall(tenantId: string, card: FloorCallCard): void {
    this.emitToTenant(tenantId, 'floor.call.updated', card);
  }

  removeFloorCall(tenantId: string, callId: string): void {
    this.emitToTenant(tenantId, 'floor.call.removed', { callId });
  }

  streamTranscript(tenantId: string, agentId: string | null, segment: TranscriptSegment, mode: 'LIVE' | 'SUMMARY' | 'BOTH'): void {
    // Transcription-display mode per PAL-10: supervisors get live always;
    // the assigned agent gets live only when the campaign mode allows it.
    this.emitToTenant(tenantId, 'transcript.supervisor', segment);
    if (agentId && mode !== 'SUMMARY') this.emitToUser(agentId, 'transcript.segment', segment);
  }

  updateSummary(tenantId: string, agentId: string | null, callId: string, summary: string): void {
    const payload = { callId, summary };
    this.emitToTenant(tenantId, 'call.summary.updated', payload);
    if (agentId) this.emitToUser(agentId, 'call.summary.updated', payload);
  }
}
