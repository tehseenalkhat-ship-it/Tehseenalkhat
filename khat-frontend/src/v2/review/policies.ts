import { useEffect, useState } from 'react';
import { apiFetch } from '@/api';
import type { EffectivePolicies, MarkBand, RubricCriterion, StepTypeDef } from '../contracts';

export type ReviewPolicies = {
  quickMarks: number[];
  rubric: RubricCriterion[];
  bands: { revisionMax: number; passMax: number };
  maxFiles: number;
  maxAttempts: number;
};

export const DEFAULT_REVIEW_POLICIES: ReviewPolicies = {
  quickMarks: [4, 5, 6, 7, 8, 9, 10],
  rubric: [],
  bands: { revisionMax: 5, passMax: 8 },
  maxFiles: 20,
  maxAttempts: 3,
};

let policyPromise: Promise<ReviewPolicies> | null = null;
export function loadReviewPolicies(): Promise<ReviewPolicies> {
  if (!policyPromise) {
    policyPromise = apiFetch<EffectivePolicies>('/v2/policies/effective', { silent: true })
      .then(p => parsePolicies(p))
      .catch(() => { policyPromise = null; return DEFAULT_REVIEW_POLICIES; });
  }
  return policyPromise;
}

function parseJson(v: unknown): unknown {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

export function parsePolicies(p: Partial<EffectivePolicies> | null | undefined): ReviewPolicies {
  const qm = parseJson(p?.['review.quick_marks']);
  const rb = parseJson(p?.['assessment.rubric']);
  const bands = parseJson(p?.['assessment.bands']) as { revisionMax?: number; passMax?: number } | null;
  const quickMarks = Array.isArray(qm) ? qm.map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 10) : DEFAULT_REVIEW_POLICIES.quickMarks;
  return {
    quickMarks: quickMarks.length ? [...new Set(quickMarks)].sort((a, b) => a - b) : DEFAULT_REVIEW_POLICIES.quickMarks,
    rubric: Array.isArray(rb) ? (rb as RubricCriterion[]).filter(c => c && c.key && c.max > 0) : [],
    bands: {
      revisionMax: Number(bands?.revisionMax ?? DEFAULT_REVIEW_POLICIES.bands.revisionMax),
      passMax: Number(bands?.passMax ?? DEFAULT_REVIEW_POLICIES.bands.passMax),
    },
    maxFiles: Number(parseJson(p?.['uploads.max_files']) ?? 20) || 20,
    maxAttempts: Number(parseJson(p?.['assessment.max_attempts']) ?? 3),
  };
}

export function useReviewPolicies(): ReviewPolicies {
  const [p, setP] = useState<ReviewPolicies>(DEFAULT_REVIEW_POLICIES);
  useEffect(() => { let alive = true; void loadReviewPolicies().then(v => { if (alive) setP(v); }); return () => { alive = false; }; }, []);
  return p;
}

export function bandFor(mark: number, bands: ReviewPolicies['bands']): MarkBand {
  if (mark <= bands.revisionMax) return 'revision';
  if (mark <= bands.passMax) return 'pass';
  return 'distinction';
}

let stepTypesPromise: Promise<StepTypeDef[]> | null = null;
export function loadStepTypes(): Promise<StepTypeDef[]> {
  if (!stepTypesPromise) {
    stepTypesPromise = apiFetch<StepTypeDef[]>('/v2/step-types', { silent: true })
      .then(r => (Array.isArray(r) ? r : []))
      .catch(() => { stepTypesPromise = null; return []; });
  }
  return stepTypesPromise;
}

/** Whether a step type is marked 1–10 (falls back to "everything except istinsakh"). */
export function useHasMarks(stepType: string | null | undefined): boolean {
  const [types, setTypes] = useState<StepTypeDef[]>([]);
  useEffect(() => { let alive = true; void loadStepTypes().then(t => { if (alive) setTypes(t); }); return () => { alive = false; }; }, []);
  if (!stepType) return true;
  const def = types.find(t => t.typeKey === stepType);
  if (def) return def.hasMarks;
  return stepType !== 'istinsakh';
}
