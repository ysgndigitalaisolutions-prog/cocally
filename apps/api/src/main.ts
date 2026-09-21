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
const IMPORT_BODY_LIMIT = '64mb';
const DEFAULT_BODY_LIMIT = '1mb';

async function bootstrap(): Promise<void> {
  // `rawBody: true` is required by the LiveKit webhook receiver: it verifies a
  // JWT whose claim is a SHA-256 of the exact request bytes, so a re-serialised
  // `req.body` will never verify. Without this, every call-progress webhook is
  // rejected and live calls never advance past RINGING.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const rawBodyVerify = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  };
  // The large limit applies to the CSV import route only; everything else,
  // including the unauthenticated login route, gets the 1 MB default.
  app.use('/api/v1/leads/import', express.json({ limit: IMPORT_BODY_LIMIT, verify: rawBodyVerify }));
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT, verify: rawBodyVerify }));
  app.use(express.urlencoded({ limit: DEFAULT_BODY_LIMIT, extended: true }));
  if (config.trustProxy) app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins, credentials: true });
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
