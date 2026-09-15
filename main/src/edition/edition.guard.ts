import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EditionService } from './edition.service';
import type { Edition } from './edition.types';

export const EDITION_KEY = 'required_edition';
export const RequiresEdition = (edition: Edition) => SetMetadata(EDITION_KEY, edition);

@Injectable()
export class EditionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly edition: EditionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Edition | undefined>(EDITION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) return true; // No edition requirement

    const current = this.edition.getEdition();

    // professional includes all community features
    if (required === 'community') return true;
    if (required === 'professional' && current !== 'professional') {
      throw new ForbiddenException(`此功能需要专业版。当前版本：${current}`);
    }

    return true;
  }
}
