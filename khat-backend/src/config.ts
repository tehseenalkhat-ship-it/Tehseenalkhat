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

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
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
};