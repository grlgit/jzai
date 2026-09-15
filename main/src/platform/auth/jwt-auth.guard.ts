import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserService } from '../../user/user.service';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly userService: UserService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if endpoint is marked @Public()
    const handler = context.getHandler();
    const className = context.getClass().name;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      handler,
      context.getClass(),
    ]);
    if (isPublic) return true;

    // WebSocket auth is enforced by each gateway's handleConnection — skip here
    // to avoid double-parsing. Gateway MUST disconnect unauthenticated clients.
    const type = context.getType<string>();
    if (type === 'ws') return true;

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers?.authorization;

    // Support token in query string for file downloads (e.g. <a href="...?token=xxx">)
    let token: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (request.query?.token) {
      token = request.query.token as string;
    }

    if (!token) {
      throw new UnauthorizedException('缺少认证令牌');
    }
    const user = this.userService.verifyToken(token);
    if (!user) {
      throw new UnauthorizedException('令牌无效或已过期');
    }

    // Attach user to request for downstream use
    request.user = user;
    return true;
  }
}
