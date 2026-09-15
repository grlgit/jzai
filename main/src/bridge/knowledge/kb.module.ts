import { Module } from '@nestjs/common';
import { KbService } from './kb.service';
import { KbController } from './kb.controller';
import { KbCategoryController, KbSynonymController } from './kb-category.controller';
import { KbAccessService } from './kb-access.service';
import { KbSignatureService } from './kb-signature.service';
import { UserModule } from '../../user/user.module';
import { WorkspaceModule } from '../../workspace/workspace.module';

@Module({
  imports: [UserModule, WorkspaceModule],
  controllers: [KbCategoryController, KbSynonymController, KbController],
  providers: [KbService, KbAccessService, KbSignatureService],
  exports: [KbService, KbAccessService, KbSignatureService],
})
export class KbModule {}
