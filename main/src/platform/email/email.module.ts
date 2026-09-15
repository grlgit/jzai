import { Module } from '@nestjs/common';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { EmailToolProvider } from './email.tools';
import { UserModule } from '../../user/user.module';
import { DbModule } from '../../db/db.module';
import { SkillModule } from '../../capability/skill/skill.module';

@Module({
  imports: [UserModule, DbModule, SkillModule],
  controllers: [EmailController],
  providers: [EmailService, EmailToolProvider],
  exports: [EmailService, EmailToolProvider],
})
export class EmailModule {}
