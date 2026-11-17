import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, Eye } from 'lucide-react';
import { getSessionUser } from '@/api';
import { navigate } from '@/components/ui';
import './v3-builder.css';

/**
 * Owner note 6.10: after "View as student" there is always a way back to the admin view.
 * The builder calls startStudentPreview(); while the flag is set and the admin is on a
 * student page, a small bar sits at the bottom with "Back to admin view".
 * The bar mounts itself (this module is imported by the builder, which App loads up front),
 * so no change in App.tsx is needed; the lead may also render <PreviewReturnBar /> directly.
 */
const KEY = 'khat.v3.previewReturn';
const STUDENT_PAGES = ['v2-course', 'v2-task', 'v2-home', 'course', 'catalog'];
type Ret = { page: string; courseId?: string | null; label: string };

export function startStudentPreview(ret: Ret): void {
  sessionStorage.setItem(KEY, JSON.stringify(ret));
  window.dispatchEvent(new Event('khat:preview-return'));
}

function readRet(): Ret | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Ret | null; } catch { return null; }
}
const page = () => window.location.hash.replace(/^#\/?/, '').split(/[?&]/)[0];

export function PreviewReturnBar() {
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => tick(n => n + 1);
    window.addEventListener('hashchange', on);
    window.addEventListener('khat:preview-return', on);
    return () => { window.removeEventListener('hashchange', on); window.removeEventListener('khat:preview-return', on); };
  }, []);
  const ret = readRet();
  const role = getSessionUser()?.role;
  if (!ret || !role || role === 'student') return null;
  const here = page();
  if (here === ret.page) { sessionStorage.removeItem(KEY); return null; }
  if (!STUDENT_PAGES.includes(here)) return null;
  const back = () => {
    if (ret.courseId) sessionStorage.setItem('khat.v2.param.builderCourseId', ret.courseId);
    sessionStorage.removeItem(KEY);
    navigate(ret.page);
    window.dispatchEvent(new Event('khat:preview-return'));
  };
  return (
    <div className="v3-preview-bar" role="region" aria-label="Student view">
      <span><Eye size={15} aria-hidden="true" /> You are seeing <b>{ret.label}</b> as a student sees it.</span>
      <button type="button" className="btn btn-primary v3-preview-back" onClick={back}><ArrowLeft size={15} /> Back to admin view</button>
    </div>
  );
}

// Self-mount once per page load.
if (typeof document !== 'undefined' && !document.getElementById('v3-preview-return')) {
  const host = document.createElement('div');
  host.id = 'v3-preview-return';
  document.body.appendChild(host);
  createRoot(host).render(<PreviewReturnBar />);
}
