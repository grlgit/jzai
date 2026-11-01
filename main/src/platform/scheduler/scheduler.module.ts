import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { SkillModule } from '../../capability/skill/skill.module';
import { AgentModule } from '../../agent/agent.module';
import { AuthzModule } from '../authz/authz.module';
import { ScheduledTaskService } from './scheduled-task.service';
import { TaskRunnerService } from './task-runner.service';
import { HeadlessAgentRunner } from './headless-agent.runner';
import { ScheduledTaskController } from './scheduled-task.controller';

/**
 * P2 全局定时器（docs/rework-2026H2/design-p2-scheduler.md）。
 * ScheduleModule.forRoot() 在 app.module 全局注册；本模块承载定时任务领域服务。
 */
@Module({
  imports: [DbModule, SkillModule, AgentModule, AuthzModule],
  providers: [ScheduledTaskService, TaskRunnerService, HeadlessAgentRunner],
  controllers: [ScheduledTaskController],
  exports: [ScheduledTaskService, TaskRunnerService],
})
export class SchedulerModule {}
