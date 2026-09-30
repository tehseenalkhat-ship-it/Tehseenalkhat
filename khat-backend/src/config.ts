import 'dotenv/config';

const r2EndpointOverride = process.env.R2_ENDPOINT_OVERRIDE?.trim() || undefined;
const r2AccountId = process.env.R2_ACCOUNT_ID?.trim() ?? '';
if (!r2EndpointOverride && !r2AccountId) {
  throw new Error('Set R2_ACCOUNT_ID for Cloudflare R2, or set R2_ENDPOINT_OVERRIDE for an S3-compatible storage service.');
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Did you copy .env.example to .env?`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  database: {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 3306),
    name: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
  },
  jwtSecret: required('JWT_SECRET'),
  r2: {
    accountId: r2AccountId,
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET_NAME'),
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