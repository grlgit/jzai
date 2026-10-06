import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

// Platform
import { DbModule } from './db/db.module';
import { CacheModule } from './cache/cache.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { AppConfigModule } from './config/app-config.module';
import { AuthModule } from './platform/auth/auth.module';
import { UserModule } from './user/user.module';
import { ModelRouterModule } from './model-router/model-router.module';
import { AnalyticsModule } from './platform/analytics/analytics.module';
import { EditionModule } from './edition/edition.module';
import { SetupModule } from './setup/setup.module';
import { UpdateModule } from './update/update.module';
import { PanelModule } from './platform/panel/panel.module';
import { OemModule } from './platform/oem/oem.module';
import { EmailModule } from './platform/email/email.module';
import { AppStoreModule } from './platform/app-store/app-store.module';

// Agent engine
import { AgentModule } from './agent/agent.module';
import { MessageDisplayModule } from './agent/support/message-display/message-display.module';

// Capability domain
import { SkillModule } from './capability/skill/skill.module';
import { ConnectorModule } from './capability/connector/connector.module';
import { AutomationModule } from './capability/automation/automation.module';
// Data domain
import { DashboardModule } from './data/dashboard/dashboard.module';
import { OcrModule } from './data/media/ocr.module';

// Bridge domain
import { KnowledgeModule } from './knowledge/knowledge.module';
import { CoWorkerModule } from './bridge/coworker/coworker.module';

import { JwtAuthGuard } from './platform/auth/jwt-auth.guard';
import { GlobalExceptionFilter } from './common/http-exception.filter';
import { AuditInterceptor } from './common/audit.interceptor';
import { AppBootstrapService } from './app-bootstrap.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
    // Platform
    AppConfigModule, CacheModule, WorkspaceModule, DbModule,
    UserModule, AuthModule, ModelRouterModule, AnalyticsModule,
    EditionModule, SetupModule, UpdateModule, PanelModule, OemModule, EmailModule, AppStoreModule,
    // Agent engine
    AgentModule, MessageDisplayModule,
    // Capability
    SkillModule, ConnectorModule, AutomationModule,
    // Data
    DashboardModule, OcrModule,
    // Bridge
    KnowledgeModule, CoWorkerModule,
  ],
  providers: [
    AppBootstrapService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
