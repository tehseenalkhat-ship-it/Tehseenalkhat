import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import './content-v3.css';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const DISMISS_KEY = 'khat.v3.installDismissed';

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Small "Install the app" bar (notes 5.5 / 1.11): Android and desktop Chrome get a one-tap
 * Install button; iPhone / iPad get the two steps for "Add to Home Screen".
 * Hidden when already installed or once dismissed. Mount once for signed-in users (App.tsx).
 */
export function V3InstallAppPrompt() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [show, setShow] = useState(false);
  const ios = isIos();

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISS_KEY)) return;
    const onPrompt = (e: Event) => { e.preventDefault(); setDeferred(e as InstallEvent); setShow(true); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    if (ios) setShow(true);
    const onInstalled = () => setShow(false);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, [ios]);

  if (!show) return null;
  const dismiss = () => { localStorage.setItem(DISMISS_KEY, '1'); setShow(false); };
  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => null);
    setDeferred(null); setShow(false);
  };

  return (
    <div className="v3c-install" role="dialog" aria-label="Install the app">
      <img src="/icons/icon-192.png" alt="" />
      <div>
        <strong>Use Tehseen al-Khat as an app</strong>
        {ios
          ? <small>Tap <Share size={12} aria-label="Share" /> Share, then “Add to Home Screen”.</small>
          : <small>Open it from your home screen, full screen.</small>}
      </div>
      {!ios && deferred && <button type="button" className="btn btn-primary" onClick={() => void install()}><Download size={15} /> Install</button>}
      <button type="button" className="v3c-icon-btn" onClick={dismiss} aria-label="Not now"><X size={16} /></button>
    </div>
  );
}
