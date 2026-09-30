import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Eraser, Undo2, X } from 'lucide-react';
import { getFileObjectUrl, getViewUrl } from '@/api';

type Point = { x: number; y: number };
type Stroke = { color: string; points: Point[] };

export function SubmissionAnnotator({
  imageStorageKey,
  fallbackImageUrl,
  imageName,
  onCancel,
  onUpload,
}: {
  imageStorageKey: string;
  fallbackImageUrl?: string | null;
  imageName: string;
  onCancel: () => void;
  onUpload: (file: File) => Promise<void>;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const activeStrokeRef = useRef<Stroke | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [imageLoadError, setImageLoadError] = useState<string | null>(null);
  const [penColor, setPenColor] = useState('#c03548');
  const [strokeCount, setStrokeCount] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setImageUrl('');
    setImageLoadError(null);
    getFileObjectUrl(imageStorageKey)
      .catch(async () => {
        if (!fallbackImageUrl) throw new Error('Could not load the source sheet. Restart the backend to enable annotation image access.');
        return getViewUrl(imageStorageKey);
      })
      .then(url => {
        objectUrl = url;
        if (cancelled) URL.revokeObjectURL(url);
        else setImageUrl(url);
      })
      .catch(loadError => {
        if (!cancelled) setImageLoadError(loadError instanceof Error ? loadError.message : 'Could not load the source sheet.');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageStorageKey, fallbackImageUrl]);

  const syncCanvasSize = () => {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas || !image.naturalWidth || !image.naturalHeight) return;
    if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
      const snapshot = strokesRef.current;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
      redraw(canvas, snapshot, image.naturalWidth, image.naturalHeight);
    }
  };

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    if (image.complete) syncCanvasSize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncCanvasSize) : null;
    if (observer && image.parentElement) observer.observe(image.parentElement);
    window.addEventListener('resize', syncCanvasSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncCanvasSize);
    };
  }, [imageUrl]);

  const getPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const drawSegment = (context: CanvasRenderingContext2D, stroke: Stroke, from: Point, to: Point) => {
    const canvas = context.canvas;
    context.beginPath();
    context.moveTo(from.x * canvas.width, from.y * canvas.height);
    context.lineTo(to.x * canvas.width, to.y * canvas.height);
    context.strokeStyle = stroke.color;
    context.lineWidth = Math.max(3, Math.min(canvas.width, canvas.height) * 0.004);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.stroke();
  };

  const redraw = (canvas: HTMLCanvasElement, strokes: Stroke[], width: number, height: number) => {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    for (const stroke of strokes) {
      for (let index = 1; index < stroke.points.length; index += 1) {
        drawSegment(context, stroke, stroke.points[index - 1], stroke.points[index]);
      }
      if (stroke.points.length === 1) {
        const point = stroke.points[0];
        drawSegment(context, stroke, point, { x: point.x + 0.0001, y: point.y + 0.0001 });
      }
    }
  };

  const startStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imageSize || uploading) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = getPoint(event);
    if (!point) return;
    const stroke = { color: penColor, points: [point] };
    activeStrokeRef.current = stroke;
    strokesRef.current = [...strokesRef.current, stroke];
    const context = canvasRef.current?.getContext('2d');
    if (context) drawSegment(context, stroke, point, { x: point.x + 0.0001, y: point.y + 0.0001 });
  };

  const continueStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const stroke = activeStrokeRef.current;
    const canvas = canvasRef.current;
    const point = getPoint(event);
    if (!stroke || !canvas || !point) return;
    event.preventDefault();
    const previous = stroke.points[stroke.points.length - 1];
    stroke.points.push(point);
    const context = canvas.getContext('2d');
    if (context) drawSegment(context, stroke, previous, point);
  };

  const finishStroke = () => {
    if (!activeStrokeRef.current) return;
    activeStrokeRef.current = null;
    setStrokeCount(strokesRef.current.length);
  };

  const undo = () => {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    if (canvasRef.current && imageSize) redraw(canvasRef.current, strokesRef.current, imageSize.width, imageSize.height);
  };

  const clear = () => {
    strokesRef.current = [];
    activeStrokeRef.current = null;
    setStrokeCount(0);
    if (canvasRef.current && imageSize) redraw(canvasRef.current, [], imageSize.width, imageSize.height);
  };

  const uploadAnnotation = async () => {
    const image = imageRef.current;
    const drawing = canvasRef.current;
    if (!image || !drawing || !imageSize || !strokeCount) return;
    setUploading(true);
    setError(null);
    try {
      const flattened = document.createElement('canvas');
      flattened.width = imageSize.width;
      flattened.height = imageSize.height;
      const context = flattened.getContext('2d');
      if (!context) throw new Error('Could not prepare the annotation image.');
      context.drawImage(image, 0, 0, flattened.width, flattened.height);
      context.drawImage(drawing, 0, 0);
      const blob = await new Promise<Blob | null>(resolve => flattened.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('Could not prepare the annotation image. Check that the source image can be edited in this browser.');
      const baseName = imageName.replace(/\.[^/.]+$/, '') || 'checkpoint-sheet';
      await onUpload(new File([blob], `${baseName}-annotated.jpg`, { type: 'image/jpeg', lastModified: Date.now() }));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Could not upload this annotation.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="submission-annotator-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget && !uploading) onCancel(); }}>
      <section className="submission-annotator" role="dialog" aria-modal="true" aria-labelledby="submission-annotator-title">
        <header className="submission-annotator-header">
          <div><p className="eyebrow">Teacher annotation</p><h2 id="submission-annotator-title">Annotate submission</h2><p>Draw directly on the sheet with your finger, stylus, or mouse. Your notes are for this student only.</p></div>
          <button type="button" className="submission-annotator-close" onClick={onCancel} disabled={uploading} aria-label="Close annotation editor"><X size={18} /></button>
        </header>
        <div className="submission-annotator-toolbar">
          <span className="submission-annotator-tool-label">Pen color</span>
          {['#c03548', '#2369a5', '#222222', '#d1841f'].map(color => <button key={color} type="button" className={`submission-annotator-color${penColor === color ? ' active' : ''}`} style={{ '--pen-color': color } as React.CSSProperties} onClick={() => setPenColor(color)} aria-label={`Select ${color} pen`} aria-pressed={penColor === color} />)}
          <span className="submission-annotator-spacer" />
          <span className="submission-annotator-count">{strokeCount} mark{strokeCount === 1 ? '' : 's'}</span>
          <button type="button" className="submission-annotator-tool" onClick={undo} disabled={!strokeCount || uploading}><Undo2 size={15} /> Undo</button>
          <button type="button" className="submission-annotator-tool" onClick={clear} disabled={!strokeCount || uploading}><Eraser size={15} /> Clear</button>
        </div>
        <div className="submission-annotator-stage">
          {imageUrl && <div className="submission-annotator-canvas-wrap" style={imageSize ? { aspectRatio: `${imageSize.width} / ${imageSize.height}` } : undefined}>
            <img ref={imageRef} src={imageUrl} alt="Checkpoint submission to annotate" onLoad={syncCanvasSize} />
            <canvas ref={canvasRef} onPointerDown={startStroke} onPointerMove={continueStroke} onPointerUp={finishStroke} onPointerCancel={finishStroke} />
          </div>}
          {!imageSize && <span className="submission-annotator-loading">{imageLoadError ?? 'Loading sheet…'}</span>}
        </div>
        {error && <p className="submission-annotator-error" role="alert">{error}</p>}
        <div className="submission-annotator-footer">
          <button type="button" className="submission-annotator-cancel" onClick={onCancel} disabled={uploading}>Cancel</button>
          <button type="button" className="submission-annotator-upload" onClick={uploadAnnotation} disabled={!strokeCount || uploading}>{uploading ? 'Uploading annotation…' : <><Check size={15} /> Annotate and upload</>}</button>
        </div>
      </section>
    </div>
  );
}
