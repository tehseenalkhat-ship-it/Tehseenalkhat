import { useEffect, useState, type SyntheticEvent } from 'react';
import { Check, Minus, Plus, RotateCcw, Undo2, X } from 'lucide-react';

type CropRatio = { id: string; label: string; value: number };

const CROP_RATIOS: CropRatio[] = [
  { id: 'square', label: '1:1', value: 1 },
  { id: 'portrait', label: '4:5', value: 4 / 5 },
  { id: 'landscape', label: '16:9', value: 16 / 9 },
];

export function ShowcaseImageEditor({ file, onCancel, onSave }: { file: File; onCancel: () => void; onSave: (file: File) => void | Promise<void> }) {
  const [imageUrl, setImageUrl] = useState('');
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [ratio, setRatio] = useState(CROP_RATIOS[0]);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    setError(null);
  };

  const save = async () => {
    if (!imageSize || !imageUrl) return;
    setSaving(true);
    setError(null);
    try {
      const cropWidth = Math.min(imageSize.width, imageSize.height * ratio.value) / zoom;
      const cropHeight = cropWidth / ratio.value;
      const sourceX = (imageSize.width - cropWidth) / 2;
      const sourceY = (imageSize.height - cropHeight) / 2;
      const outputWidth = 1200;
      const outputHeight = Math.round(outputWidth / ratio.value);
      const canvas = document.createElement('canvas');
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not prepare this image.');
      context.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
      context.translate(outputWidth / 2, outputHeight / 2);
      context.rotate((rotation * Math.PI) / 180);
      context.drawImage(await createImageBitmap(file), -sourceX * (outputWidth / cropWidth) - outputWidth / 2, -sourceY * (outputHeight / cropHeight) - outputHeight / 2, imageSize.width * (outputWidth / cropWidth), imageSize.height * (outputHeight / cropHeight));
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('Could not prepare this image.');
      const name = file.name.replace(/\.[^/.]+$/, '') || 'showcase-image';
      await onSave(new File([blob], `${name}-edited.jpg`, { type: 'image/jpeg', lastModified: Date.now() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not edit this image.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="showcase-editor-backdrop" onPointerDown={event => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
      <section className="showcase-editor" role="dialog" aria-modal="true" aria-labelledby="showcase-editor-title">
        <header className="showcase-editor-header"><div><span className="eyebrow">Prepare your piece</span><h2 id="showcase-editor-title">Edit your photo</h2><p>Choose a frame, adjust the image, and make the piece ready for the guild.</p></div><button type="button" className="showcase-editor-close" onClick={onCancel} disabled={saving} aria-label="Close image editor"><X size={18} /></button></header>
        <div className="showcase-editor-layout">
          <div className="showcase-editor-stage" style={{ aspectRatio: ratio.value }}>
            {imageUrl && <img src={imageUrl} alt="Preview of showcase submission" onLoad={handleImageLoad} style={{ filter: `brightness(${brightness}%) contrast(${contrast}%)`, transform: `scale(${zoom}) rotate(${rotation}deg)` }} />}
          </div>
          <div className="showcase-editor-controls">
            <div className="showcase-editor-control"><strong>Frame</strong><div className="showcase-editor-ratios">{CROP_RATIOS.map(option => <button type="button" key={option.id} className={ratio.id === option.id ? 'active' : ''} onClick={() => setRatio(option)}>{option.label}</button>)}</div></div>
            <div className="showcase-editor-control"><label htmlFor="showcase-zoom">Zoom <output>{Math.round(zoom * 100)}%</output></label><div className="showcase-editor-slider"><button type="button" onClick={() => setZoom(value => Math.max(1, value - .1))} aria-label="Zoom out"><Minus size={15} /></button><input id="showcase-zoom" type="range" min="1" max="2.5" step=".01" value={zoom} onChange={event => setZoom(Number(event.currentTarget.value))} /><button type="button" onClick={() => setZoom(value => Math.min(2.5, value + .1))} aria-label="Zoom in"><Plus size={15} /></button></div></div>
            <div className="showcase-editor-control"><label htmlFor="showcase-brightness">Brightness <output>{brightness}%</output></label><input id="showcase-brightness" type="range" min="70" max="130" value={brightness} onChange={event => setBrightness(Number(event.currentTarget.value))} /></div>
            <div className="showcase-editor-control"><label htmlFor="showcase-contrast">Contrast <output>{contrast}%</output></label><input id="showcase-contrast" type="range" min="70" max="130" value={contrast} onChange={event => setContrast(Number(event.currentTarget.value))} /></div>
            <div className="showcase-editor-actions"><button type="button" className="showcase-editor-rotate" onClick={() => setRotation(value => (value + 90) % 360)}><RotateCcw size={15} /> Rotate 90°</button><button type="button" className="showcase-editor-reset" onClick={() => { setRatio(CROP_RATIOS[0]); setZoom(1); setRotation(0); setBrightness(100); setContrast(100); }}><Undo2 size={15} /> Reset</button></div>
          </div>
        </div>
        {error && <p className="showcase-editor-error" role="alert">{error}</p>}
        <footer className="showcase-editor-footer"><button type="button" className="showcase-editor-cancel" onClick={onCancel} disabled={saving}>Cancel</button><button type="button" className="showcase-editor-save" onClick={save} disabled={!imageSize || saving}>{saving ? 'Preparing…' : <><Check size={15} /> Use this photo</>}</button></footer>
      </section>
    </div>
  );
}
