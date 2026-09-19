import { Injectable } from '@nestjs/common';
import {
  createDevMcpPrincipal,
  createSystemPrincipal,
  createUserPrincipal,
  InvocationPrincipal,
} from './invocation-principal';

@Injectable()
export class InvocationContextFactory {
  fromRequest(req: any, origin = 'http'): InvocationPrincipal | undefined {
    return req?.user?.id ? createUserPrincipal(req.user, origin) : undefined;
  }

  forDevMcp(actorId: string): InvocationPrincipal {
    return createDevMcpPrincipal(actorId);
  }

  forSystem(origin: string, scopes: readonly string[] = []): InvocationPrincipal {
    return createSystemPrincipal(origin, scopes);
  }
}
