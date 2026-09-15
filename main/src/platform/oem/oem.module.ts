import { Module } from '@nestjs/common';
import { OemService } from './oem.service';
import { OemController } from './oem.controller';
import { OemAdminController } from './oem-admin.controller';
import { UserModule } from '../../user/user.module';
import { EditionModule } from '../../edition/edition.module';

@Module({
  imports: [UserModule, EditionModule],
  controllers: [OemController, OemAdminController],
  providers: [OemService],
  exports: [OemService],
})
export class OemModule {}
