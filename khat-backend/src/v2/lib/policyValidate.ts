/** Pure validation of policy values (friendly messages for the policies screen). */
import type { PolicyKey } from '../contracts.js';

/** Keep in step with PolicyKey in contracts.ts (no DB import here so tests stay pure). */
export const KNOWN_POLICY_KEYS: PolicyKey[] = [
  'review.reviewers_required', 'review.turnaround_days', 'assessment.bands', 'assessment.rubric', 'assessment.max_attempts',
  'print.instructions', 'print.allow_multi', 'downloads.stamp_fields', 'downloads.watermark', 'downloads.copyright_text',
  'merit.levels_per_point', 'merit.certification_points', 'merit.monthly_cap', 'merit.officer_user_id', 'merit.reminder_day',
  'showcase.requires_approval', 'uploads.max_files', 'student.choose_one_size', 'review.divert_after_hours',
  'review.auto_mark_enabled', 'review.auto_mark_after_days', 'review.quick_marks', 'review.comment_templates',
  'email.student_on_reply', 'email.staff_mode', 'nudge.inactive_days', 'nudge.dormant_days', 'nudge.message_template',
];

const isInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isStr = (v: unknown, max = 5000) => typeof v === 'string' && v.length <= max;

/** Returns null when valid, else a plain-English error. Numbers sent as strings are not accepted (send JSON numbers). */
export function validatePolicyValue(key: string, value: unknown): string | null {
  if (!(KNOWN_POLICY_KEYS as string[]).includes(key)) return `Unknown setting "${key}".`;
  const k = key as PolicyKey;
  switch (k) {
    case 'review.reviewers_required': return isInt(value, 1, 5) ? null : 'Reviewers required must be a whole number from 1 to 5.';
    case 'review.turnaround_days': return isInt(value, 1, 60) ? null : 'Turnaround must be 1 to 60 days.';
    case 'assessment.max_attempts': return isInt(value, 0, 50) ? null : 'Attempts must be 0 (unlimited) to 50.';
    case 'merit.levels_per_point': return isInt(value, 1, 50) ? null : 'Levels per merit point must be 1 to 50.';
    case 'merit.certification_points': return isInt(value, 0, 100) ? null : 'Certification points must be 0 to 100.';
    case 'merit.monthly_cap': return isInt(value, 1, 100) ? null : 'Monthly cap must be 1 to 100.';
    case 'merit.reminder_day': return isInt(value, 1, 28) ? null : 'Reminder day must be a day from 1 to 28.';
    case 'uploads.max_files': return isInt(value, 1, 100) ? null : 'Files per submission must be 1 to 100.';
    case 'review.divert_after_hours': return isInt(value, 1, 24 * 60) ? null : 'Divert after must be a number of hours (1 or more).';
    case 'review.auto_mark_after_days': return isInt(value, 1, 120) ? null : 'Automatic mark after must be 1 to 120 days.';
    case 'nudge.inactive_days': return isInt(value, 1, 3650) ? null : 'Inactive days must be 1 or more.';
    case 'nudge.dormant_days': return isInt(value, 1, 3650) ? null : 'Dormant days must be 1 or more.';
    case 'print.allow_multi':
    case 'showcase.requires_approval':
    case 'student.choose_one_size':
    case 'review.auto_mark_enabled':
    case 'email.student_on_reply':
      return typeof value === 'boolean' ? null : 'Choose yes or no.';
    case 'print.instructions':
    case 'downloads.copyright_text':
    case 'nudge.message_template':
      return isStr(value) ? null : 'Please enter text (up to 5000 characters).';
    case 'merit.officer_user_id':
      return value === null || (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) ? null : 'Choose a person (or nobody).';
    case 'email.staff_mode':
      return value === 'instant' || value === 'daily_digest' || value === 'off' ? null : 'Staff email must be instant, daily digest or off.';
    case 'assessment.bands': {
      const b = value as { revisionMax?: unknown; passMax?: unknown } | null;
      if (!b || typeof b !== 'object') return 'Bands need a revision limit and a pass limit.';
      if (!isInt(b.revisionMax, 0, 9) || !isInt(b.passMax, 1, 10)) return 'Band limits must be whole marks between 0 and 10.';
      if ((b.revisionMax as number) >= (b.passMax as number)) return 'The revision limit must be lower than the pass limit.';
      return null;
    }
    case 'assessment.rubric': {
      if (!Array.isArray(value) || !value.length) return 'The rubric needs at least one criterion.';
      for (const c of value as { key?: unknown; label?: unknown; max?: unknown }[]) {
        if (!c || typeof c !== 'object' || !isStr(c.key, 64) || !(c.key as string).trim() || !isStr(c.label, 200) || !(c.label as string).trim() || !isInt(c.max, 1, 10)) {
          return 'Each rubric criterion needs a key, a label and a maximum from 1 to 10.';
        }
      }
      const keys = (value as { key: string }[]).map(c => c.key);
      return new Set(keys).size === keys.length ? null : 'Rubric keys must be different from each other.';
    }
    case 'downloads.stamp_fields': {
      const allowed = ['name', 'email', 'tr', 'class', 'branch', 'date'];
      return Array.isArray(value) && value.every(v => allowed.includes(v as string)) ? null : `Stamp fields can only be: ${allowed.join(', ')}.`;
    }
    case 'downloads.watermark': {
      const w = value as { storageKey?: unknown; opacity?: unknown; position?: unknown; scale?: unknown } | null;
      if (!w || typeof w !== 'object') return 'Watermark settings are missing.';
      if (!(w.storageKey === null || typeof w.storageKey === 'string')) return 'Watermark image is not valid.';
      if (typeof w.opacity !== 'number' || w.opacity < 0 || w.opacity > 1) return 'Watermark opacity must be between 0 and 1.';
      if (!['center', 'bottom-right', 'diagonal-tile'].includes(w.position as string)) return 'Watermark position must be center, bottom-right or diagonal-tile.';
      if (typeof w.scale !== 'number' || w.scale <= 0 || w.scale > 2) return 'Watermark scale must be between 0 and 2.';
      return null;
    }
    case 'review.quick_marks':
      return Array.isArray(value) && value.length > 0 && value.length <= 10 && value.every(v => isInt(v, 1, 10)) ? null : 'Quick marks must be marks from 1 to 10.';
    case 'review.comment_templates': {
      const t = value as Record<string, unknown> | null;
      if (!t || typeof t !== 'object') return 'Comment templates are missing.';
      for (const band of ['revision', 'pass', 'distinction']) {
        const list = t[band];
        if (!Array.isArray(list) || !list.length || !list.every(s => isStr(s, 2000) && (s as string).trim())) {
          return `Add at least one comment for "${band}".`;
        }
      }
      return null;
    }
    default:
      return null;
  }
}
