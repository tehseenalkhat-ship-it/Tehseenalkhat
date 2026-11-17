import { uploadFile } from '@/api';
import type { Attachment } from '../contracts';
import { canvasToBlob, loadImage } from './pdf';

const MAX_SIDE = 2600;

/** Phone photos are often 5–10 MB: shrink big JPEG/PNG/HEIC-decoded images before upload. PDFs pass through. */
export async function prepareForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size < 1.2 * 1024 * 1024) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.86);
    if (blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadAttachment(prefix: string, file: File, forStepId?: string | null): Promise<Attachment> {
  const ready = await prepareForUpload(file);
  const contentType = ready.type || (/\.pdf$/i.test(ready.name) ? 'application/pdf' : 'application/octet-stream');
  const up = await uploadFile(prefix, ready);
  return { storageKey: up.storageKey, originalFilename: up.originalFilename || ready.name, contentType, ...(forStepId !== undefined ? { forStepId } : {}) };
}

export const ACCEPT_FILES = 'image/*,application/pdf,.pdf';
export function acceptable(file: File): boolean {
  return file.type.startsWith('image/') || file.type === 'application/pdf' || /\.(pdf|jpe?g|png|webp|heic)$/i.test(file.name);
}
