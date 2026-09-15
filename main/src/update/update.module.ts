import { Module, forwardRef } from '@nestjs/common';
import { UpdateService } from './update.service';
import { UpdateController } from './update.controller';
import { UserModule } from '../user/user.module';
import { EditionModule } from '../edition/edition.module';

@Module({
  imports: [UserModule, forwardRef(() => EditionModule)],
  controllers: [UpdateController],
  providers: [UpdateService],
  exports: [UpdateService],
})
export class UpdateModule {}
