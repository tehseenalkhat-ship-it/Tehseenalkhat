import { API_BASE_URL, getToken } from '@/api';

// owner: admin-comms — small helpers shared by the v3 admin pages.

/** Downloads a file from an authenticated API path (Excel, PDF, CSV) and saves it. */
export async function downloadFromApi(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
  if (!res.ok) {
    let message = 'Could not download this file.';
    try { message = (await res.json()).error ?? message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('Could not read this file.'));
    reader.readAsDataURL(file);
  });
}

/** Policy keys in plain words — used where the audit log names a key. */
export const POLICY_WORDS: Record<string, string> = {
  'review.reviewers_required': 'Teachers who check each piece of work',
  'review.turnaround_days': 'Answer within',
  'assessment.bands': 'What a mark means',
  'assessment.rubric': 'Marking criteria',
  'assessment.max_attempts': 'Tries for an assessment',
  'print.instructions': 'Download message',
  'print.allow_multi': 'Print many sheets at once',
  'downloads.stamp_fields': 'Name band on every page',
  'downloads.watermark': 'Watermark',
  'downloads.copyright_text': 'Copyright line',
  'merit.levels_per_point': 'Levels for one merit point',
  'merit.certification_points': 'Points for a full certification',
  'merit.monthly_cap': 'Most merit points in one month',
  'merit.officer_user_id': 'Who gives merit points',
  'merit.reminder_day': 'Merit reminder day',
  'showcase.requires_approval': 'Check showcase requests first',
  'uploads.max_files': 'Files in one upload',
  'student.choose_one_size': 'Student picks one mistar size',
  'review.divert_after_hours': 'Pass to another teacher after',
  'review.auto_mark_enabled': 'Automatic mark when nobody answers',
  'review.auto_mark_after_days': 'Automatic mark after',
  'review.quick_marks': 'One-tap marks',
  'review.comment_templates': 'Warm comments',
  'email.student_on_reply': 'Email students on every reply',
  'email.staff_mode': 'Teacher emails',
  'nudge.inactive_days': '“Needs a push” after',
  'nudge.dormant_days': 'Gentle email after',
  'nudge.message_template': 'The gentle message',
};

/** "Marol / Mumbai: setting print.instructions changed from X to Y" → plain words. */
export function plainPolicySummary(summary: string, key: string | null): string {
  const label = key ? POLICY_WORDS[key] ?? key : null;
  let s = summary.replace(/^[^:]+:\s*/, '');
  if (label && key) s = s.replace(`setting ${key}`, `“${label}”`);
  return s.replace('the global value', 'the standard value').replace('back to the global value', 'back to the standard value');
}
