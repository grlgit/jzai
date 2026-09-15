import { Module } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UserModule } from '../../user/user.module';

@Module({
  imports: [UserModule],
  providers: [JwtAuthGuard],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
