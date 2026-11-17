import type { InboxItem, PrintPackRequest } from '../contracts';
import { apiFetchBlob, extOf, fileBlob, safeName } from '../chat/media';

/** `<printCode>_<student>_<step>_<n>.ext` */
export function zipName(item: InboxItem, n: number, original: string, contentType?: string | null): string {
  const step = [item.step.levelCode, item.step.code].filter(Boolean).join('-');
  return `${item.submission.printCode}_${safeName(item.student.name)}_${step}_${n}.${extOf(original, contentType)}`;
}

export async function downloadZip(items: InboxItem[], onProgress: (done: number, total: number) => void): Promise<{ failed: number }> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const jobs = items.flatMap(item => item.submission.files.map((f, i) => ({ item, f, n: i + 1 })));
  let done = 0;
  let failed = 0;
  onProgress(0, jobs.length);
  // 3 at a time keeps phones responsive
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try { zip.file(zipName(job.item, job.n, job.f.originalFilename, job.f.contentType), await fileBlob(job.f.storageKey)); }
      catch { failed += 1; }
      done += 1;
      onProgress(done, jobs.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const blob = await zip.generateAsync({ type: 'blob' });
  const stamp = new Date().toISOString().slice(0, 10);
  saveBlob(blob, `khat-reviews-${stamp}.zip`);
  return { failed };
}

/** File name of one stamped PDF: `Zainab-Najmi_Fann-al-Khat-1_TK-V19E0.pdf`. */
export function stampedName(item: InboxItem): string {
  return `${safeName(item.student.name)}_${safeName(item.step.courseTitle)}_${item.submission.printCode}.pdf`;
}

/** One stamped PDF (student details + sheet ID + QR on every page) of one submission's uploaded work. */
export async function stampedPdf(item: InboxItem): Promise<Blob> {
  const body: PrintPackRequest = { submissionIds: [item.submission.id], include: 'all_files' };
  return apiFetchBlob('/v2/review/print-pack', body);
}

export async function downloadStamped(item: InboxItem): Promise<void> {
  saveBlob(new Blob([await stampedPdf(item)], { type: 'application/pdf' }), stampedName(item));
}

/**
 * Bulk download: a ZIP with one stamped PDF per student (name, TR, class, branch, date, sheet ID and QR
 * on every page) — print, mark on paper, scan, and "Upload marked items" sends each page back.
 */
export async function downloadStampedZip(items: InboxItem[], onProgress: (done: number, total: number) => void): Promise<{ failed: number }> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  let done = 0;
  let failed = 0;
  onProgress(0, items.length);
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try { zip.file(stampedName(item), await stampedPdf(item)); }
      catch { failed += 1; }
      done += 1;
      onProgress(done, items.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (failed === items.length) throw new Error('The files could not be prepared. Please try again.');
  saveBlob(await zip.generateAsync({ type: 'blob' }), `marking-pack-${new Date().toISOString().slice(0, 10)}-${items.length}.zip`);
  return { failed };
}

export async function openPrintPack(submissionIds: string[], include: PrintPackRequest['include']): Promise<void> {
  // Open the tab first (inside the click) so pop-up blockers allow it.
  const tab = window.open('', '_blank');
  try {
    const body: PrintPackRequest = { submissionIds, include };
    const blob = await apiFetchBlob('/v2/review/print-pack', body);
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    if (tab && !tab.closed) tab.location.href = url;
    else saveBlob(blob, `print-pack-${new Date().toISOString().slice(0, 10)}.pdf`);
    window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
