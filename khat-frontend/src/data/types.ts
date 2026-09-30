export type Script = 'Naskh' | 'Naskh (Normal Pen)' | 'Sulus' | 'Nastaaleeq';
export type Role = 'student' | 'teacher' | 'coordinator' | 'admin';
export type Page = string;

export type KhatType = {
  name: string;
  arabic: string;
  color: string;
  soft: string;
  desc: string;
  tagline: string;
};

export type LevelType = 'practice' | 'checkpoint';

export type CourseLevel = {
  id: number;
  name: string;
  type: LevelType;
  exercises?: number;
  locked?: boolean;
  complete?: boolean;
  current?: boolean;
};

export type CertificateTier = 'Foundation' | 'Composition' | 'Mastery';

export type Certificate = {
  script: Script;
  tier: CertificateTier;
  earned: boolean;
  date?: string;
  levelRequired: number;
};

