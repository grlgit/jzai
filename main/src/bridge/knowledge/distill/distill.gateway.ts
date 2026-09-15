import { Logger, OnModuleInit } from '@nestjs/common';
import {
  WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DistillService } from './distill.service';
import { UserService } from '../../../user/user.service';

/**
 * DistillGateway — 蒸馏实时进度推送（"蒸一条弹一条"）。
 * 前端 connect /ws/distill → emit distill.watch{runId} 加入房间 → 收 distill.progress 事件。
 * 后端监听 DistillService.events('progress')，按 runId 转发到对应房间。
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : true, credentials: true },
  namespace: '/ws/distill',
})
export class DistillGateway implements OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(DistillGateway.name);
  @WebSocketServer() server: Server;

  constructor(
    private readonly distill: DistillService,
    private readonly userService: UserService,
  ) {}

  onModuleInit() {
    this.distill.events.on('progress', (p: any) => {
      if (p?.runId) this.server?.to(`run:${p.runId}`).emit('distill.progress', p);
    });
  }

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.token || (client.handshake.query.token as string);
    if (!token || !this.userService.verifyToken(token)) {
      client.disconnect();
    }
  }

  @SubscribeMessage('distill.watch')
  watch(@ConnectedSocket() client: Socket, @MessageBody() data: { runId: string }) {
    if (data?.runId) client.join(`run:${data.runId}`);
  }

  @SubscribeMessage('distill.unwatch')
  unwatch(@ConnectedSocket() client: Socket, @MessageBody() data: { runId: string }) {
    if (data?.runId) client.leave(`run:${data.runId}`);
  }
}
