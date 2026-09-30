import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// Cloudflare R2 and MinIO both expose an S3-compatible API. Keep the R2
// endpoint as the default, but allow an explicit endpoint for self-hosted S3
// services. Path-style URLs are required by many MinIO deployments.
const s3 = new S3Client({
  region: config.r2.region,
  endpoint: config.r2.endpointOverride ?? `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
  forcePathStyle: config.r2.forcePathStyle,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

const PRESIGNED_URL_EXPIRY_SECONDS = 60 * 10; // 10 minutes — plenty for a single upload/download

/**
 * Builds a consistent storage key. `prefix` groups files by what they are
 * (e.g. 'levels', 'entries', 'showcase', 'certificates') so the bucket stays
 * organized even though it's all one flat bucket under the hood.
 */
export function buildStorageKey(prefix: string, originalFilename: string): string {
  const ext = originalFilename.includes('.') ? originalFilename.split('.').pop() : undefined;
  const unique = randomUUID();
  return ext ? `${prefix}/${unique}.${ext}` : `${prefix}/${unique}`;
}

/**
 * Returns a short-lived URL the FRONTEND uploads directly to via a PUT request
 * (no file bytes ever pass through our server). Call this from a route like
 * POST /uploads/presign, given a desired prefix + filename + content type.
 */
export async function getUploadUrl(storageKey: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: config.r2.bucket,
    Key: storageKey,
    ContentType: contentType,
  });
  return getSignedUrl(s3, command, { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS });
}

/**
 * Returns a short-lived URL to VIEW/DOWNLOAD a private file. Since the bucket
 * is not public, every view of a student's upload, a course video, etc. goes
 * through this — call it right before returning data to the frontend, not
 * ahead of time (the URL expires quickly by design).
 */
export async function getDownloadUrl(storageKey: string, downloadFilename?: string): Promise<string> {
  const safeFilename = downloadFilename?.replace(/[\r\n"/\\]/g, '_').trim();
  const command = new GetObjectCommand({
    Bucket: config.r2.bucket,
    Key: storageKey,
    ...(safeFilename ? {
      ResponseContentDisposition: `attachment; filename="${safeFilename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
    } : {}),
  });
  return getSignedUrl(s3, command, { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS });
}

export async function getObjectBytes(storageKey: string): Promise<{ body: Buffer; contentType: string }> {
  const result = await s3.send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: storageKey }));
  if (!result.Body) throw new Error('Stored file has no content');
  return {
    body: Buffer.from(await result.Body.transformToByteArray()),
    contentType: result.ContentType ?? 'application/octet-stream',
  };
}

export async function deleteObject(storageKey: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: storageKey }));
}

export async function objectExists(storageKey: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.r2.bucket, Key: storageKey }));
    return true;
  } catch (error) {
    const name = (error as { name?: string }).name;
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (name === 'NotFound' || name === 'NoSuchKey' || statusCode === 404) return false;
    throw error;
  }
}
