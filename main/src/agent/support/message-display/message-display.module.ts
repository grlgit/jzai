import { Module } from '@nestjs/common';
import { MessageDisplayService } from './message-display.service';
import { MessageDisplayController } from './message-display.controller';
import { AgentModule } from '../../agent.module';

@Module({
  imports: [AgentModule],
  controllers: [MessageDisplayController],
  providers: [MessageDisplayService],
  exports: [MessageDisplayService],
})
export class MessageDisplayModule {}
