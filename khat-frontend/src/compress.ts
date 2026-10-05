// Shrinks files in the browser before upload, so the server only ever stores small files.
//   Images -> WebP (JPEG where the browser can't encode WebP), resized/re-encoded until under 1 MB.
//   Videos -> MP4 (H.264 + AAC), at most 720p on the short side, 30 fps, medium quality bitrate.
// Anything that can't be compressed (PDF, GIF, SVG, unsupported codec/browser) is uploaded as-is.

const IMAGE_MAX_BYTES = 1024 * 1024;
const IMAGE_MAX_DIMENSION = 2560;
const VIDEO_MAX_SHORT_SIDE = 720;

export type CompressProgress = (fraction: number) => void;

function renamed(name: string, ext: string): string {
  const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  return `${base}.${ext}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function compressImage(file: File): Promise<File> {
  if (file.size <= IMAGE_MAX_BYTES) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // applies EXIF orientation in modern browsers
  } catch {
    return file; // e.g. HEIC in browsers that can't decode it
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;

  let maxDim = IMAGE_MAX_DIMENSION;
  let best: Blob | null = null;
  try {
    for (let pass = 0; pass < 6; pass++) {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));

      for (const type of ['image/webp', 'image/jpeg']) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (type === 'image/jpeg') {
          ctx.fillStyle = '#fff'; // JPEG has no transparency
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        for (const quality of [0.85, 0.75, 0.65, 0.55]) {
          const blob = await canvasToBlob(canvas, type, quality);
          if (!blob || blob.type !== type) break; // browser can't encode this type, try the next
          if (!best || blob.size < best.size) best = blob;
          if (blob.size <= IMAGE_MAX_BYTES) {
            const ext = type === 'image/webp' ? 'webp' : 'jpg';
            return new File([blob], renamed(file.name, ext), { type });
          }
        }
        if (best) break; // the type worked but was still too big: shrink dimensions instead
      }
      maxDim = Math.round(Math.max(canvas.width, canvas.height) * 0.75);
    }
  } finally {
    bitmap.close();
  }

  if (best && best.size < file.size) {
    const ext = best.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([best], renamed(file.name, ext), { type: best.type });
  }
  return file;
}

async function compressVideo(file: File, onProgress?: CompressProgress): Promise<File> {
  if (typeof VideoEncoder === 'undefined') return file; // no WebCodecs: upload original

  try {
    const { Input, Output, Conversion, ALL_FORMATS, BlobSource, Mp4OutputFormat, BufferTarget, Quality } =
      await import('mediabunny'); // loaded only when a video is uploaded

    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });

    const conversion = await Conversion.init({
      input,
      output,
      video: (track) => {
        const w = track.displayWidth;
        const h = track.displayHeight;
        const scale = Math.min(1, VIDEO_MAX_SHORT_SIDE / Math.min(w, h));
        // even dimensions keep H.264 encoders happy
        const width = Math.round((w * scale) / 2) * 2;
        const height = Math.round((h * scale) / 2) * 2;
        return { codec: 'avc', width, height, fit: 'contain', frameRate: 30, bitrate: new Quality('medium'), forceTranscode: true };
      },
      audio: { codec: 'aac', bitrate: 96_000 },
      showWarnings: false,
    });
    if (!conversion.isValid) return file;

    if (onProgress) conversion.onProgress = (p) => onProgress(p);
    await conversion.execute();

    const buffer = target.buffer;
    if (!buffer || buffer.byteLength >= file.size) return file; // never make it bigger
    return new File([buffer], renamed(file.name, 'mp4'), { type: 'video/mp4' });
  } catch (err) {
    console.warn('Video compression failed, uploading original', err);
    return file;
  }
}

export async function compressForUpload(file: File, onProgress?: CompressProgress): Promise<File> {
  const type = file.type.toLowerCase();
  if (/^image\/(jpeg|jpg|png|webp|bmp|heic|heif|avif|tiff)$/.test(type)) return compressImage(file);
  if (type.startsWith('video/')) return compressVideo(file, onProgress);
  return file;
}
