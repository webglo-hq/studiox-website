import { z } from 'zod';

/** Server configuration from environment variables (see .env.example). */
const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4610),
  HOST: z.string().default('127.0.0.1'),
  PUBLIC_ORIGIN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  EVENKEEL_DATA_DIR: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  EVENKEEL_ENGINE: z.enum(['auto', 'offline', 'live']).default('auto'),
  EVENKEEL_CLOCK: z.enum(['scenario', 'system']).default('scenario'),
  EVENKEEL_MODEL_FAST: z.string().optional(),
  EVENKEEL_MODEL_BALANCED: z.string().optional(),
  EVENKEEL_MODEL_DEEP: z.string().optional(),
  DEMO_PASSWORD: z.string().optional(),
  DEMO_LOGIN_HELPER: z.string().optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  EVENKEEL_SECRET_KEY: z.string().optional(),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().optional(),
  /** Multiply rate-limit budgets (automated test runs only; must stay 1 in production). */
  RATE_LIMIT_SCALE: z.coerce.number().min(1).max(1000).default(1),
});

export interface ServerConfig {
  production: boolean;
  port: number;
  host: string;
  publicOrigin: string | null;
  databaseUrl: string | null;
  dataDir: string | null;
  anthropicApiKey: string | null;
  engine: 'auto' | 'offline' | 'live';
  clock: 'scenario' | 'system';
  modelEnv: Record<string, string | undefined>;
  demoPassword: string | null;
  demoLoginHelper: boolean;
  session: { idleMinutes: number; absoluteHours: number; rotateMinutes: number };
  secretKey: string | null;
  cookieSecure: 'auto' | boolean;
  oidc: { issuer: string; clientId: string; redirectUri: string | null } | null;
  rateLimitScale: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  // An empty value (KEY= in .env) means "not set".
  const e = Env.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== '')));
  const production = e.NODE_ENV === 'production';
  const helper = e.DEMO_LOGIN_HELPER === '1' || e.DEMO_LOGIN_HELPER === 'true';
  if (production && helper) throw new Error('DEMO_LOGIN_HELPER must be off in production.');
  if (production && e.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD must not be set in production.');
  if (production && e.RATE_LIMIT_SCALE !== 1) throw new Error('RATE_LIMIT_SCALE must be 1 in production.');
  if (e.DEMO_PASSWORD && e.DEMO_PASSWORD.length < 12) throw new Error('DEMO_PASSWORD must be at least 12 characters.');
  return {
    production,
    port: e.PORT,
    host: e.HOST,
    publicOrigin: e.PUBLIC_ORIGIN ?? null,
    databaseUrl: e.DATABASE_URL || null,
    dataDir: e.EVENKEEL_DATA_DIR ?? null,
    anthropicApiKey: e.ANTHROPIC_API_KEY || null,
    engine: e.EVENKEEL_ENGINE,
    clock: e.EVENKEEL_CLOCK,
    modelEnv: { EVENKEEL_MODEL_FAST: e.EVENKEEL_MODEL_FAST, EVENKEEL_MODEL_BALANCED: e.EVENKEEL_MODEL_BALANCED, EVENKEEL_MODEL_DEEP: e.EVENKEEL_MODEL_DEEP },
    demoPassword: e.DEMO_PASSWORD || null,
    demoLoginHelper: helper,
    session: { idleMinutes: e.SESSION_IDLE_MINUTES, absoluteHours: e.SESSION_ABSOLUTE_HOURS, rotateMinutes: 15 },
    secretKey: e.EVENKEEL_SECRET_KEY || null,
    cookieSecure: e.COOKIE_SECURE === 'auto' ? 'auto' : e.COOKIE_SECURE === 'true',
    oidc: e.OIDC_ISSUER && e.OIDC_CLIENT_ID ? { issuer: e.OIDC_ISSUER, clientId: e.OIDC_CLIENT_ID, redirectUri: e.OIDC_REDIRECT_URI ?? null } : null,
    rateLimitScale: e.RATE_LIMIT_SCALE,
  };
}
