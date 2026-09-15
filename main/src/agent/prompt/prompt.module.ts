import { Module } from '@nestjs/common';
import { PromptEnhancerService } from './prompt-enhancer.service';

@Module({
  providers: [PromptEnhancerService],
  exports: [PromptEnhancerService],
})
export class PromptModule {}
