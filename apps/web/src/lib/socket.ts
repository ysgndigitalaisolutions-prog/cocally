'use client';

import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  if (typeof window === 'undefined') return null;
  const token = localStorage.getItem('cocally.token');
  if (!token) return null;
  if (!socket) {
    socket = io(`${API_URL}/ws`, { auth: { token }, transports: ['websocket'] });
  }
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
