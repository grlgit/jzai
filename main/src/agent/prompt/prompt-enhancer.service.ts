import { Injectable } from '@nestjs/common';

/**
 * Stub — drawing-specific learning removed in L4-C.
 * Retained to satisfy PromptEnhancerLoaderService injection.
 * The only active enhancer is `injectActiveDistillRuns` which lives in the loader itself.
 */
@Injectable()
export class PromptEnhancerService {
  async enhancePromptForDrawingAgent(basePrompt: string, _userId: string): Promise<string> {
    return basePrompt;
  }
}
