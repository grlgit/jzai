import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { WorkspaceModule } from '../../workspace/workspace.module';
import { ResourceMetaService } from './resource-meta.service';
import { ResourceGrantService } from './resource-grant.service';
import { ResourceAccessService } from './resource-access.service';
import { AuthzController } from './authz.controller';

/**
 * P1 权限体系底座（docs/rework-2026H2/design-p1-authz.md）。
 * 约束：本模块只依赖 DbModule/WorkspaceModule/UserModule，
 * 不得反向依赖任何能力模块（agent/skill/mcp/tool）——防循环依赖。
 */
@Module({
  imports: [DbModule, WorkspaceModule],
  controllers: [AuthzController],
  providers: [ResourceMetaService, ResourceGrantService, ResourceAccessService],
  exports: [ResourceMetaService, ResourceGrantService, ResourceAccessService],
})
export class AuthzModule {}
