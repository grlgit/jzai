import { Module } from '@nestjs/common';
import { UserModule } from '../user/user.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SpacesService } from './spaces.service';
import { KbAccessService } from './kb-access.service';
import { VaultFsService } from './vaultfs/vaultfs.service';
import { TaxonomyService } from './taxonomy/taxonomy.service';
import { KnowledgeToolsService } from './tools/knowledge-tools.service';
import { ProcessorService } from './processor/processor.service';
import { KbApiController } from './kb-api.controller';
import { KbCategoryController, KbSynonymController } from './kb-category.controller';
// 旧桥接存根（仅为 distill 编译兼容保留，见文件内 @deprecated 说明）
import { KbService } from '../bridge/knowledge/kb.service';
import { KbSignatureService } from '../bridge/knowledge/kb-signature.service';

/**
 * KnowledgeModule — 知识库（企业心智）模块。
 * kbs 独立服务并入主台后的落点：空间管理、VaultFS、工具执行层、文档处理管线、HTTP API。
 */
@Module({
  imports: [UserModule, WorkspaceModule],
  controllers: [KbApiController, KbCategoryController, KbSynonymController],
  providers: [
    SpacesService, KbAccessService, VaultFsService, TaxonomyService,
    KnowledgeToolsService, ProcessorService,
    KbService, KbSignatureService,
  ],
  exports: [
    SpacesService, KbAccessService, VaultFsService, TaxonomyService,
    KnowledgeToolsService, ProcessorService,
    KbService, KbSignatureService,
  ],
})
export class KnowledgeModule {}
