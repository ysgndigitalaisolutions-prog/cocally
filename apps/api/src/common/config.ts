import { z } from 'zod';

const envSchema = z.object({
  MONGODB_URI: z.string().default('mongodb://localhost:27017/cocally'),
  JWT_SECRET: z.string().default('dev-secret-do-not-use-in-production'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  VAULT_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'VAULT_KEY must be 32 bytes hex')
    .default('0'.repeat(64)),
  TELEPHONY_DRIVER: z.enum(['SIMULATION', 'SIP']).default('SIMULATION'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  RECORDINGS_DIR: z.string().default('./recordings-data'),
  ELEVENLABS_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
});

const parsed = envSchema.parse(process.env);

export const config = {
  mongoUri: parsed.MONGODB_URI,
  jwtSecret: parsed.JWT_SECRET,
  jwtExpiresIn: parsed.JWT_EXPIRES_IN,
  vaultKey: parsed.VAULT_KEY,
  telephonyDriver: parsed.TELEPHONY_DRIVER,
  port: parsed.PORT,
  corsOrigin: parsed.CORS_ORIGIN,
  recordingsDir: parsed.RECORDINGS_DIR,
  providerKeys: {
    elevenlabs: parsed.ELEVENLABS_API_KEY,
    deepgram: parsed.DEEPGRAM_API_KEY,
    openai: parsed.OPENAI_API_KEY,
    anthropic: parsed.ANTHROPIC_API_KEY,
    google: parsed.GOOGLE_API_KEY,
  },
} as const;

export type AppConfig = typeof config;
