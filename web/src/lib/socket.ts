'use client';

import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;
let currentToken: string | null = null;

/** WebSocket URL: dev mode connects directly to backend, production uses Gateway (same origin) */
function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  // Dev mode: NEXT_PUBLIC_MODE=local → use NEXT_PUBLIC_MAIN_URL for direct backend connection
  // Production/Docker: Gateway on same origin handles WS upgrade → empty string
  if (process.env.NEXT_PUBLIC_MODE === 'local' && process.env.NEXT_PUBLIC_MAIN_URL) {
    return process.env.NEXT_PUBLIC_MAIN_URL;
  }
  return '';
}

export function getSocket(token?: string | null): Socket {
  // Force reconnect if token changed
  if (socket && token !== currentToken) {
    socket.disconnect();
    socket = null;
  }
  // active = 已连接或正在（重）连接中——绝不能销毁握手中的连接。
  // 此前用 socket?.connected 判断：两个调用方几乎同时调用时，
  // 先到者创建的、仍在握手的 socket 会被后到者误判销毁并重建，
  // 先到者持有的引用永久 socketConnected=false，chat.send 死在本地。
  if (socket?.active) return socket;
  if (socket) { socket.disconnect(); socket = null; }

  currentToken = token || null;
  const wsUrl = getWsUrl();
  socket = io(`${wsUrl}/ws/chat`, {
    transports: ['websocket'],
    autoConnect: true,
    auth: token ? { token } : undefined,
    query: token ? { token } : undefined,
  });

  socket.on('connect', () => {
    console.log('[WS] Connected:', socket?.id);
  });

  socket.on('disconnect', () => {
    console.log('[WS] Disconnected');
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) { socket.disconnect(); socket = null; }
}
