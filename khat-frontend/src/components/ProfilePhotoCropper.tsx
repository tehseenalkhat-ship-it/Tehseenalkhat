import { useEffect, useRef, useState, type PointerEvent, type SyntheticEvent } from 'react';
import { Minus, Plus, X } from 'lucide-react';

type ProfilePhotoCropperProps = {
  file: File;
  saving?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSave: (file: File) => void | Promise<void>;
};

const INITIAL_CROP_SIZE = 300;
const OUTPUT_SIZE = 512;
const MAX_ZOOM = 3;

type CropOffset = { x: number; y: number };
type DragStart = { pointerX: number; pointerY: number; x: number; y: number };

function clampOffset(value: number, imageSize: number, cropSize: number): number {
  return Math.min(0, Math.max(cropSize - imageSize, value));
}

export function ProfilePhotoCropper({ file, saving = false, error, onCancel, onSave }: ProfilePhotoCropperProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef<DragStart | null>(null);
  const [cropSize, setCropSize] = useState(INITIAL_CROP_SIZE);
  const [imageUrl, setImageUrl] = useState('');
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [baseScale, setBaseScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<CropOffset>({ x: 0, y: 0 });
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      const nextSize = Math.round(Math.min(entry.contentRect.width, entry.contentRect.height));
      if (nextSize > 0) setCropSize(nextSize);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!imageSize) return;
    const scale = Math.max(cropSize / imageSize.width, cropSize / imageSize.height);
    setBaseScale(scale);
    setZoom(1);
    setOffset({
      x: (cropSize - imageSize.width * scale) / 2,
      y: (cropSize - imageSize.height * scale) / 2,
    });
  }, [cropSize, imageSize]);

  const displayedWidth = (imageSize?.width ?? 0) * baseScale * zoom;
  const displayedHeight = (imageSize?.height ?? 0) * baseScale * zoom;

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (!naturalWidth || !naturalHeight) {
      setImageError('This image could not be opened. Please choose another photo.');
      return;
    }
    setImageSize({ width: naturalWidth, height: naturalHeight });
    setImageError(null);
  };

  const moveCrop = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current || !imageSize) return;
    const nextX = dragStart.current.x + event.clientX - dragStart.current.pointerX;
    const nextY = dragStart.current.y + event.clientY - dragStart.current.pointerY;
    setOffset({
      x: clampOffset(nextX, displayedWidth, cropSize),
      y: clampOffset(nextY, displayedHeight, cropSize),
    });
  };

  const changeZoom = (nextZoom: number) => {
    if (!imageSize) return;
    const boundedZoom = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
    const oldScale = baseScale * zoom;
    const newScale = baseScale * boundedZoom;
    const centerX = (cropSize / 2 - offset.x) / oldScale;
    const centerY = (cropSize / 2 - offset.y) / oldScale;
    const nextWidth = imageSize.width * newScale;
    const nextHeight = imageSize.height * newScale;
    setOffset({
      x: clampOffset(cropSize / 2 - centerX * newScale, nextWidth, cropSize),
      y: clampOffset(cropSize / 2 - centerY * newScale, nextHeight, cropSize),
    });
    setZoom(boundedZoom);
  };

  const saveCrop = async () => {
    const image = imageRef.current;
    const scale = baseScale * zoom;
    if (!image || !imageSize || !scale || imageError) return;

    const cropSourceSize = cropSize / scale;
    const sourceX = Math.min(imageSize.width - cropSourceSize, Math.max(0, -offset.x / scale));
    const sourceY = Math.min(imageSize.height - cropSourceSize, Math.max(0, -offset.y / scale));
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const context = canvas.getContext('2d');
    if (!context) {
      setImageError('Your browser could not prepare this photo. Please try another image.');
      return;
    }

    context.drawImage(image, sourceX, sourceY, cropSourceSize, cropSourceSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      setImageError('Your browser could not prepare this photo. Please try again.');
      return;
    }

    const baseName = file.name.replace(/\.[^/.]+$/, '') || 'profile-photo';
    await onSave(new File([blob], `${baseName}-profile.jpg`, { type: 'image/jpeg', lastModified: Date.now() }));
  };

  return (
    <div className="photo-crop-backdrop" onPointerDown={event => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
      <section className="photo-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="photo-crop-title">
        <header className="photo-crop-header">
          <div>
            <span className="photo-crop-kicker">Personalize your profile</span>
            <h2 id="photo-crop-title">Frame your photo</h2>
            <p>Drag to position your image, then zoom until it feels right.</p>
          </div>
          <button className="photo-crop-close" type="button" onClick={onCancel} disabled={saving} aria-label="Close photo editor"><X size={19} /></button>
        </header>

        <div className="photo-crop-body">
          <div
            ref={stageRef}
            className={`photo-crop-stage${imageSize ? ' is-ready' : ''}`}
            onPointerDown={event => {
              if (!imageSize || saving) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragStart.current = { pointerX: event.clientX, pointerY: event.clientY, x: offset.x, y: offset.y };
            }}
            onPointerMove={moveCrop}
            onPointerUp={() => { dragStart.current = null; }}
            onPointerCancel={() => { dragStart.current = null; }}
            aria-label="Drag the image to adjust the circular profile crop"
          >
            {imageUrl && (
              <img
                ref={imageRef}
                src={imageUrl}
                alt="Photo being cropped"
                onLoad={handleImageLoad}
                onError={() => setImageError('This image could not be opened. Please choose another photo.')}
                draggable={false}
                className="photo-crop-image"
                style={{ width: displayedWidth, height: displayedHeight, left: offset.x, top: offset.y }}
              />
            )}
            <div className="photo-crop-shade" aria-hidden="true" />
            <div className="photo-crop-circle" aria-hidden="true" />
            {!imageSize && !imageError && <span className="photo-crop-loading">Preparing your image…</span>}
          </div>

          <div className="photo-crop-controls">
            <div className="photo-crop-zoom-label"><span>Zoom</span><strong>{Math.round(zoom * 100)}%</strong></div>
            <div className="photo-crop-slider-row">
              <button type="button" onClick={() => changeZoom(zoom - 0.1)} disabled={zoom <= 1 || saving} aria-label="Zoom out"><Minus size={16} /></button>
              <input
                type="range"
                min="1"
                max={MAX_ZOOM}
                step="0.01"
                value={zoom}
                onChange={event => changeZoom(Number(event.currentTarget.value))}
                disabled={!imageSize || saving}
                aria-label="Photo zoom"
              />
              <button type="button" onClick={() => changeZoom(zoom + 0.1)} disabled={zoom >= MAX_ZOOM || saving} aria-label="Zoom in"><Plus size={16} /></button>
            </div>
            <p className="photo-crop-hint">Your photo will appear as a circle across your profile.</p>
          </div>
        </div>

        {(imageError || error) && <p className="photo-crop-error" role="alert">{imageError ?? error}</p>}
        <footer className="photo-crop-footer">
          <button className="photo-crop-cancel" type="button" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="photo-crop-save" type="button" onClick={saveCrop} disabled={!imageSize || Boolean(imageError) || saving}>
            {saving ? <><span className="photo-crop-spinner" /> Saving photo…</> : 'Save profile photo'}
          </button>
        </footer>
      </section>
    </div>
  );
}
