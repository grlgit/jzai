import { Global, Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { FileCleanupService } from './file-cleanup.service';

@Global()
@Module({
  providers: [WorkspaceService, FileCleanupService],
  exports: [WorkspaceService, FileCleanupService],
})
export class WorkspaceModule {}
