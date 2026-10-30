import 'dotenv/config';

const r2EndpointOverride = process.env.R2_ENDPOINT_OVERRIDE?.trim() || undefined;
const r2AccountId = process.env.R2_ACCOUNT_ID?.trim() ?? '';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Did you copy .env.example to .env?`);
  }
  return value;
}

// Either DATABASE_URL=mysql://user:pass@host:3306/name (as set on the hosting panel)
// or the separate DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD variables.
const databaseUrl = process.env.DATABASE_URL?.trim() ? new URL(process.env.DATABASE_URL.trim()) : undefined;

export const config = {
  port: Number(process.env.PORT ?? 4000),
  database: databaseUrl
    ? {
        host: databaseUrl.hostname,
        port: Number(databaseUrl.port || 3306),
        name: decodeURIComponent(databaseUrl.pathname.replace(/^\//, '')),
        user: decodeURIComponent(databaseUrl.username),
        password: decodeURIComponent(databaseUrl.password),
        sslCa: process.env.DB_SSL_CA?.trim() || undefined,
      }
    : {
        host: required('DB_HOST'),
        port: Number(process.env.DB_PORT ?? 3306),
        name: required('DB_NAME'),
        user: required('DB_USER'),
        password: required('DB_PASSWORD'),
        sslCa: process.env.DB_SSL_CA?.trim() || undefined,
      },
  jwtSecret: required('JWT_SECRET'),
  // First password for staff accounts an admin creates (they must change it on first sign-in).
  // Set STAFF_DEFAULT_PASSWORD on the hosting panel; without it a random one is generated per account.
  staffDefaultPassword: process.env.STAFF_DEFAULT_PASSWORD?.trim() || undefined,
  // Uploads are stored on the server's disk (see storage.ts). These S3 settings are only used by
  // LiveKit Egress to save event recordings, and are optional.
  r2: {
    accountId: r2AccountId,
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.R2_BUCKET_NAME ?? '',
    endpointOverride: r2EndpointOverride,
    forcePathStyle: process.env.R2_FORCE_PATH_STYLE === 'true',
    region: process.env.R2_REGION?.trim() || (r2EndpointOverride ? 'us-east-1' : 'auto'),
  },
  livekit: {
    apiUrl: process.env.LIVEKIT_API_URL ?? 'http://localhost:7880',
    wsUrl: process.env.LIVEKIT_WS_URL ?? 'ws://localhost:7880',
    apiKey: process.env.LIVEKIT_API_KEY ?? '',
    apiSecret: process.env.LIVEKIT_API_SECRET ?? '',
  },
  assistant: {
    baseUrl: process.env.ASSISTANT_BASE_URL ?? '',
    model: process.env.ASSISTANT_MODEL ?? '',
    apiKey: process.env.ASSISTANT_API_KEY ?? '',
  },
  // Optional on purpose — emails print to console until set
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM ?? 'no-reply@example.com',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  // Password for the private /logs page. When unset, /logs is disabled (404).
  logsPassword: process.env.LOGS_PASSWORD?.trim() || undefined,
};