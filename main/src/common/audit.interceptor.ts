import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { DbService } from '../db/db.service';

const AUDIT_KEY = 'audit_metadata';

/** Decorator: mark a controller method for audit logging */
export const Audit = (action: string, resource: string) =>
  SetMetadata(AUDIT_KEY, { action, resource });

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly db: DbService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const audit = this.reflector.get<{ action: string; resource: string } | undefined>(
      AUDIT_KEY,
      context.getHandler(),
    );
    if (!audit) return next.handle();

    // Only handle HTTP contexts
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest();
    const user = req.user;

    return next.handle().pipe(
      tap(async (result) => {
        try {
          await this.db.query(
            `INSERT INTO jz_audit_log (user_id, user_name, action, resource, resource_id, detail, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              user?.id || null,
              user?.username || user?.email || null,
              audit.action,
              audit.resource,
              req.params?.id || (result as any)?.id || null,
              JSON.stringify({ body: req.body }),
              req.ip,
              req.headers?.['user-agent'] || null,
            ],
          );
        } catch (e: any) {
          // Audit failure must not break business logic
          console.error(`[Audit] Write failed: ${e.message}`);
        }
      }),
    );
  }
}
