import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { DingtalkService } from './dingtalk.service';
import { FeishuService } from './feishu.service';

@Module({
  controllers: [UserController],
  providers: [UserService, DingtalkService, FeishuService],
  exports: [UserService],
})
export class UserModule {}
