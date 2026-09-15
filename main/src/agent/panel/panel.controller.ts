import { Controller, Get } from '@nestjs/common';
import { Public } from '../../platform/auth/public.decorator';
import { PanelMessageRegistry } from '../panel/panel-message-registry.service';

@Controller('api/panel')
export class PanelController {
  constructor(private readonly registry: PanelMessageRegistry) {}

  @Public()
  @Get('message-handlers')
  listHandlers() {
    return this.registry.list();
  }
}
