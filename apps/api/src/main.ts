import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './common/config';

/**
 * Lead lists arrive as a CSV in the request body, and Express defaults to a
 * 100 kB limit — about 2,000 leads. A real BPO list is 50k–100k rows (~5 MB),
 * so every genuine import failed with a bare 413. Raised to cover a ~500k-row
 * file with headroom.
 */
const BODY_LIMIT = '64mb';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ limit: BODY_LIMIT, extended: true }));
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigin, credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`CoCally API listening on :${config.port}`);
}

void bootstrap();
