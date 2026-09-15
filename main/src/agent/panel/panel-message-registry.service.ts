import { Injectable, Logger } from '@nestjs/common';

export interface PanelHandlerSpec {
  appId?: string;
  description?: string;
}

export interface PanelHandlerInfo extends PanelHandlerSpec {
  panelId: string;
}

@Injectable()
export class PanelMessageRegistry {
  private readonly logger = new Logger(PanelMessageRegistry.name);
  private readonly handlers = new Map<string, PanelHandlerSpec>();

  register(panelId: string, spec: PanelHandlerSpec): void {
    this.handlers.set(panelId, spec);
    this.logger.log(`Registered panel message handler: ${panelId}`);
  }

  remove(panelId: string): void {
    this.handlers.delete(panelId);
    this.logger.log(`Removed panel message handler: ${panelId}`);
  }

  /** Remove all handlers registered by a given app (called on deactivate/uninstall). */
  removeByApp(appId: string): void {
    for (const [panelId, spec] of this.handlers) {
      if (spec.appId === appId) {
        this.handlers.delete(panelId);
        this.logger.log(`Removed panel message handler: ${panelId}`);
      }
    }
  }

  has(panelId: string): boolean {
    return this.handlers.has(panelId);
  }

  list(): PanelHandlerInfo[] {
    return Array.from(this.handlers.entries()).map(([panelId, spec]) => ({
      panelId,
      ...spec,
    }));
  }
}
