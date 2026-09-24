import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Loaded here (not main.ts) so every entrypoint that reads `config` — the
// server, seed scripts, tests — picks up apps/api/.env the same way. No-ops
// silently if the file is absent (e.g. CI, or vars set directly in the shell).
loadDotenv();

/** `.env` files commonly leave optional vars declared-but-blank (`FOO=`); an
 * empty string should mean "unset", not fail `.url()`/other validators. */
const optionalString = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const optionalUrl = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
/**
 * Strict boolean. `z.coerce.boolean()` is `Boolean(value)`, so the literal
 * string "false" was TRUE — a footgun that silently enabled recording and DNC
 * washing. Only "true", "1", "yes", "on" (any case) are true; anything else,
 * including blank and "false", is false.
 */
const envBool = () =>
  z.preprocess((v) => {
    if (typeof v === 'boolean') return v;
    if (v === undefined || v === null) return false;
    return ['true', '1', 'yes', 'on'].includes(String(v).trim().toLowerCase());
  }, z.boolean());

const DEV_JWT_SECRET = 'dev-secret-do-not-use-in-production';
const DEV_VAULT_KEY = '0'.repeat(64);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017/cocally'),
  JWT_SECRET: z.string().default(DEV_JWT_SECRET),
  /** Longer than a shift: an 8 h token expired mid-call and the 401 redirect tore the call bar down. */
  JWT_EXPIRES_IN: z.string().default('12h'),
  VAULT_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'VAULT_KEY must be 32 bytes hex')
    .default(DEV_VAULT_KEY),
  TELEPHONY_DRIVER: z.enum(['SIMULATION', 'SIP']).default('SIMULATION'),
  /** Minutes without a client heartbeat before a staffed agent is auto-signed-out. */
  PRESENCE_TIMEOUT_MINUTES: z.coerce.number().min(1).default(5),
  /** Grace after an agent's last socket drops before the floor marks them OFFLINE (a reload takes ~2 s). */
  PRESENCE_DISCONNECT_GRACE_SECONDS: z.coerce.number().min(5).default(45),
  /** IANA zone the business day (daily dial budgets/quotas) is counted in. */
  BUSINESS_TIMEZONE: z.string().default('Australia/Sydney'),
  PORT: z.coerce.number().default(4000),
  /** Comma-separated allowed browser origins. Required in production. */
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  /** Set when the API sits behind a reverse proxy (Caddy, LB) so client IPs and HTTPS are read from X-Forwarded-*. */
  TRUST_PROXY: envBool(),
  /** Allows the unauthenticated browser "lead" join token used by the live-voice demo. Never enable on a client tenant. */
  DEMO_LEAD_TOKEN_ENABLED: envBool(),
  RECORDINGS_DIR: z.string().default('./recordings-data'),
  ELEVENLABS_API_KEY: optionalString(),
  DEEPGRAM_API_KEY: optionalString(),
  OPENAI_API_KEY: optionalString(),
  ANTHROPIC_API_KEY: optionalString(),
  GOOGLE_API_KEY: optionalString(),
  GROQ_API_KEY: optionalString(),

  // --- Live telephony (only required when TELEPHONY_DRIVER=SIP). See
  //     claude-dev/2026-07-19-live-call-build-plan.md for the full design. ---
  /** Public HTTPS base URL Twilio/LiveKit call back into (e.g. ngrok / prod host). */
  PUBLIC_BASE_URL: optionalUrl(),
  /** Shared bearer the Python LiveKit Agents worker uses to reach POST /engine/turn. */
  ENGINE_SERVICE_TOKEN: optionalString(),
  /** LiveKit Cloud project — media plane + SIP bridge. */
  LIVEKIT_URL: optionalString(),
  LIVEKIT_API_KEY: optionalString(),
  LIVEKIT_API_SECRET: optionalString(),
  /** LiveKit outbound SIP trunk id (dial-out) once the carrier trunk is wired. */
  LIVEKIT_SIP_TRUNK_ID: optionalString(),
  /** Twilio account backing the SIP trunk / numbers. */
  TWILIO_ACCOUNT_SID: optionalString(),
  TWILIO_AUTH_TOKEN: optionalString(),

  // --- Floor operations -------------------------------------------------
  /** Seconds an agent may stay in WRAP_UP before being returned to AVAILABLE. */
  WRAP_UP_MAX_SECONDS: z.coerce.number().min(5).default(90),
  /** Seconds a receiving agent has to accept an agent-to-agent transfer. */
  AGENT_TRANSFER_ACCEPT_SECONDS: z.coerce.number().min(5).max(120).default(20),
  /**
   * Audio played to a parked customer (hold) and during transfer hand-off.
   * Without this the customer hears dead silence through the accept window —
   * the single most demo-breaking defect in the transfer flow.
   */
  HOLD_MUSIC_URL: optionalString(),
  /** Campaign worklist size below which supervisors get a hopper-low alert. */
  HOPPER_LOW_THRESHOLD: z.coerce.number().min(0).default(50),

  // --- Recording --------------------------------------------------------
  /** Turn on real dual-leg audio capture via LiveKit Egress. */
  RECORDING_ENABLED: envBool(),
  /** S3/GCS bucket for finished recordings; falls back to local RECORDINGS_DIR. */
  RECORDING_BUCKET: optionalString(),
  RECORDING_S3_REGION: optionalString(),
  RECORDING_S3_ACCESS_KEY: optionalString(),
  RECORDING_S3_SECRET: optionalString(),
  RECORDING_S3_ENDPOINT: optionalString(),

  // --- ACMA Do Not Call Register ---------------------------------------
  /**
   * Real-time washing web service. Without these the AU country pack blocks
   * every lead with DNC_WASH_STALE and the floor sits idle — which is the
   * correct fail-closed behaviour, and exactly why this must be configured
   * before go-live rather than after.
   */
  DNCR_ENABLED: envBool(),
  DNCR_ACCOUNT_ID: optionalString(),
  DNCR_PASSPHRASE: optionalString(),
  DNCR_ENDPOINT: z.string().default('https://www.donotcall.gov.au/dncrtelem/rtw/washing.cfc'),
  /** Numbers per SOAP request. The service recommends 200; 500 is the hard ceiling. */
  DNCR_BATCH_SIZE: z.coerce.number().min(1).max(500).default(200),
  /**
   * Re-wash anything older than this. The safe-harbour is 30 days, so 25
   * leaves five days of margin for a scheduler outage.
   */
  DNCR_REWASH_AFTER_DAYS: z.coerce.number().min(1).max(30).default(25),
});

const parsed = envSchema
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (env.JWT_SECRET === DEV_JWT_SECRET || env.JWT_SECRET.length < 32)
      fail('JWT_SECRET', 'must be set to a random value of at least 32 characters in production');
    if (env.VAULT_KEY === DEV_VAULT_KEY) fail('VAULT_KEY', 'must be a random 32-byte hex key in production');
    if (env.MONGODB_URI.includes('localhost')) fail('MONGODB_URI', 'points at localhost in production');
    if (env.CORS_ORIGIN.includes('localhost')) fail('CORS_ORIGIN', 'must list the real browser origin(s) in production');
    if (!env.ENGINE_SERVICE_TOKEN || env.ENGINE_SERVICE_TOKEN.length < 32)
      fail('ENGINE_SERVICE_TOKEN', 'must be a random value of at least 32 characters in production');
    if (env.DEMO_LEAD_TOKEN_ENABLED) fail('DEMO_LEAD_TOKEN_ENABLED', 'must not be enabled in production');
  })
  .parse(process.env);

export const config = {
  nodeEnv: parsed.NODE_ENV,
  isProduction: parsed.NODE_ENV === 'production',
  mongoUri: parsed.MONGODB_URI,
  jwtSecret: parsed.JWT_SECRET,
  jwtExpiresIn: parsed.JWT_EXPIRES_IN,
  vaultKey: parsed.VAULT_KEY,
  telephonyDriver: parsed.TELEPHONY_DRIVER,
  presenceTimeoutMinutes: parsed.PRESENCE_TIMEOUT_MINUTES,
  presenceDisconnectGraceSeconds: parsed.PRESENCE_DISCONNECT_GRACE_SECONDS,
  businessTimezone: parsed.BUSINESS_TIMEZONE,
  port: parsed.PORT,
  corsOrigin: parsed.CORS_ORIGIN,
  corsOrigins: parsed.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
  trustProxy: parsed.TRUST_PROXY,
  demoLeadTokenEnabled: parsed.DEMO_LEAD_TOKEN_ENABLED,
  recordingsDir: parsed.RECORDINGS_DIR,
  providerKeys: {
    elevenlabs: parsed.ELEVENLABS_API_KEY,
    deepgram: parsed.DEEPGRAM_API_KEY,
    openai: parsed.OPENAI_API_KEY,
    anthropic: parsed.ANTHROPIC_API_KEY,
    google: parsed.GOOGLE_API_KEY,
    groq: parsed.GROQ_API_KEY,
  },
  publicBaseUrl: parsed.PUBLIC_BASE_URL,
  engineServiceToken: parsed.ENGINE_SERVICE_TOKEN,
  livekit: {
    url: parsed.LIVEKIT_URL,
    apiKey: parsed.LIVEKIT_API_KEY,
    apiSecret: parsed.LIVEKIT_API_SECRET,
    sipTrunkId: parsed.LIVEKIT_SIP_TRUNK_ID,
  },
  twilio: {
    accountSid: parsed.TWILIO_ACCOUNT_SID,
    authToken: parsed.TWILIO_AUTH_TOKEN,
  },
  floor: {
    wrapUpMaxSeconds: parsed.WRAP_UP_MAX_SECONDS,
    agentTransferAcceptSeconds: parsed.AGENT_TRANSFER_ACCEPT_SECONDS,
    holdMusicUrl: parsed.HOLD_MUSIC_URL,
    hopperLowThreshold: parsed.HOPPER_LOW_THRESHOLD,
  },
  recording: {
    enabled: parsed.RECORDING_ENABLED,
    bucket: parsed.RECORDING_BUCKET,
    s3Region: parsed.RECORDING_S3_REGION,
    s3AccessKey: parsed.RECORDING_S3_ACCESS_KEY,
    s3Secret: parsed.RECORDING_S3_SECRET,
    s3Endpoint: parsed.RECORDING_S3_ENDPOINT,
  },
  dncr: {
    enabled: parsed.DNCR_ENABLED,
    accountId: parsed.DNCR_ACCOUNT_ID,
    passphrase: parsed.DNCR_PASSPHRASE,
    endpoint: parsed.DNCR_ENDPOINT,
    batchSize: parsed.DNCR_BATCH_SIZE,
    rewashAfterDays: parsed.DNCR_REWASH_AFTER_DAYS,
  },
} as const;

/** True when the live media plane is configured well enough to place real calls. */
export const isLiveTelephony = (): boolean =>
  config.telephonyDriver === 'SIP' &&
  Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret && config.livekit.sipTrunkId);

export type AppConfig = typeof config;
