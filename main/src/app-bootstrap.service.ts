import { Injectable, Logger } from '@nestjs/common';
import { AppActivationService } from './platform/app-store/services/app-activation.service';

/**
 * One-shot bootstrap after NestJS has started.
 * Activates all installed apps so their backends and tool providers are ready.
 */
@Injectable()
export class AppBootstrapService {
  private readonly logger = new Logger(AppBootstrapService.name);

  constructor(private readonly activation: AppActivationService) {}

  async bootstrap(): Promise<void> {
    this.logger.log('Bootstrapping installed apps...');
    await this.activation.activateAll();
  }
}
