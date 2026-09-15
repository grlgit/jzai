import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { initDatabase } from './db/init-database';
import { AppBootstrapService } from './app-bootstrap.service';

// 增加请求体大小限制以支持大量尺寸数据的过滤
import * as express from 'express';

async function bootstrap() {
  // Phase 1: DB migrations + seed data (sequential, before NestJS starts)
  await initDatabase();

  // Phase 2: NestJS application (all tables guaranteed to exist)
  const app = await NestFactory.create(AppModule);
  (global as any).nestApp = app;

  // Phase 2.5: Activate installed app packages (needs global.nestApp)
  await app.get(AppBootstrapService).bootstrap();

  // S2: CORS 白名单（生产环境必须配置 CORS_ORIGINS，否则拒绝跨域）
  const corsOrigins = process.env.CORS_ORIGINS;
  const isProduction = process.env.NODE_ENV === 'production';
  app.enableCors({
    origin: corsOrigins
      ? corsOrigins.split(',').map(s => s.trim()).filter(Boolean)
      : isProduction
        ? false
        : true,
    credentials: true,
  });

  // Wave 1: Security headers
  app.use(helmet({
    contentSecurityPolicy: false,       // SPA requires inline scripts
    crossOriginEmbedderPolicy: false,   // Allow embedding external resources
  }));

  // S8: 全局输入校验
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // 增加请求体大小限制以支持大量尺寸数据（默认100kb -> 1mb）
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ limit: '1mb', extended: true }));

  await app.listen(process.env.PORT ?? 1111);
}
bootstrap();
