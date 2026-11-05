import { Module } from '@nestjs/common';
import { PanelService } from './panel.service';
import { PanelController } from './panel.controller';
import { UserModule } from '../../user/user.module';
import { ChatSupportModule } from '../../agent/support/chat-support.module';
import { AuthzModule } from '../authz/authz.module';

@Module({
  // ChatSupportModule 提供 AgentRegistryService（供侧栏带出面板的配对智能体显示名）
  // AuthzModule 提供 ResourceAccessService（配对智能体按可见性透出，053 起 connector_master 仅管理员）
  imports: [UserModule, ChatSupportModule, AuthzModule],
  controllers: [PanelController],
  providers: [PanelService],
  exports: [PanelService],
})
export class PanelModule {}
