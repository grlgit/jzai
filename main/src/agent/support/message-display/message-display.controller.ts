import { Controller, Get, Put, Body, Req } from '@nestjs/common';
import { MessageDisplayService, MessageDisplayConfig } from './message-display.service';

@Controller('api/message-display')
export class MessageDisplayController {
  constructor(private readonly service: MessageDisplayService) {}

  @Get()
  async getConfig(@Req() req: any) {
    return this.service.getFullConfig(req.user?.id);
  }

  @Put('global')
  async setGlobal(@Body() body: Partial<MessageDisplayConfig>) {
    await this.service.setGlobal(body);
    return { success: true };
  }

  @Put('user')
  async setUser(
    @Req() req: any,
    @Body() body: { agentId?: string; config: Partial<MessageDisplayConfig> },
  ) {
    await this.service.setUserConfig(req.user?.id, body.agentId || '_all', body.config);
    return { success: true };
  }
}
