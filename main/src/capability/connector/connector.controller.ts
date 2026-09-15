import { Controller, Get, Post, Delete, Param } from '@nestjs/common';
import { SkillRegistryService } from '../skill/skill-registry.service';

@Controller('api/skills-legacy')
export class SkillsController {
  constructor(private readonly skills: SkillRegistryService) {}

  @Get()
  list() {
    return this.skills.getAll().map(s => ({
      name: s.name, description: s.description,
      system: s.metadata?.system || '', hasHandler: s.hasHandler,
    }));
  }

  @Post('reload')
  reload() {
    this.skills.loadAll();
    return { skills: this.skills.getAll().length };
  }
}
