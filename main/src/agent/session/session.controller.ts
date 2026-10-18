import { Controller, Get, Post, Delete, Put, Body, Param, Query, Req } from '@nestjs/common';
import { SessionService } from './session.service';
import { parsePagination, paginatedResult } from '../../common/pagination.dto';

@Controller('api/sessions')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Get()
  async list(
    @Query('agentType') agentType: string,
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    const { page: p, limit: l, offset } = parsePagination({ page: Number(page), limit: Number(limit) });
    const [sessions, total] = await Promise.all([
      this.sessionService.listSessions(userId, agentType || 'main', l, offset),
      this.sessionService.countSessions(userId, agentType || 'main'),
    ]);
    return paginatedResult(sessions, total, p, l);
  }

  @Post()
  async create(@Body() body: { agentType?: string }, @Req() req: any) {
    const id = await this.sessionService.createSession(req.user?.id, body.agentType || 'main');
    return { id };
  }

  @Get('stats')
  async stats() {
    return this.sessionService.getAgentStats();
  }

  @Get('settings/current')
  async getSettings(@Req() req: any) {
    const [max, welcomeTitle] = await Promise.all([
      this.sessionService.getMaxSessions(req.user?.id),
      this.sessionService.getWelcomeTitle(req.user?.id),
    ]);
    return { maxSessions: max, welcomeTitle };
  }

  @Put('settings/current')
  async updateSettings(@Body() body: { maxSessions?: number; welcomeTitle?: string }, @Req() req: any) {
    if (body.maxSessions !== undefined) {
      await this.sessionService.setMaxSessions(req.user?.id, body.maxSessions);
    }
    if (body.welcomeTitle !== undefined) {
      await this.sessionService.setWelcomeTitle(req.user?.id, body.welcomeTitle);
    }
    return { success: true };
  }

  @Get('by-skill/:skillName')
  async getBySkill(@Param('skillName') skillName: string) {
    const session = await this.sessionService.getSessionBySkill(skillName);
    if (!session) return { session: null };
    const messages = await this.sessionService.getMessages(session.id);
    return { session, messages };
  }

  @Get(':id/messages')
  async getMessages(@Param('id') id: string) {
    return this.sessionService.getMessages(id);
  }

  @Delete(':id')
  async deleteSession(@Param('id') id: string) {
    await this.sessionService.deleteSession(id);
    return { success: true };
  }

  @Post(':id/bind-skill')
  async bindSkill(@Param('id') id: string, @Body() body: { skillName: string }) {
    await this.sessionService.bindSkill(id, body.skillName);
    return { success: true };
  }
}
