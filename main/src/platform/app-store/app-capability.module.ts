import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { AppCapabilityService } from './services/app-capability.service';

/**
 * 独立成模块（仅依赖 DbModule），供 SkillModule / ToolRegistryModule / AppStoreModule
 * 共同注入而不产生循环依赖。
 */
@Module({
  imports: [DbModule],
  providers: [AppCapabilityService],
  exports: [AppCapabilityService],
})
export class AppCapabilityModule {}
