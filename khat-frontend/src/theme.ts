export type ThemeName = 'sky' | 'lavender' | 'sage' | 'rose';

export const DEFAULT_THEME: ThemeName = 'sky';

export const THEME_OPTIONS: { id: ThemeName; label: string; family: string; colors: [string, string, string] }[] = [
  { id: 'sky', label: 'Ocean blue', family: 'Ocean blue', colors: ['#003049', '#0077b6', '#ffffff'] },
  { id: 'lavender', label: 'Sapphire', family: 'Sapphire', colors: ['#003049', '#315fc4', '#ffffff'] },
  { id: 'sage', label: 'Cerulean', family: 'Cerulean', colors: ['#003049', '#168aad', '#ffffff'] },
  { id: 'rose', label: 'Steel blue', family: 'Steel blue', colors: ['#003049', '#2f6690', '#ffffff'] },
];

const STORAGE_PREFIX = 'khat_theme:';

export function readThemePreference(userId?: string | null): ThemeName {
  const value = localStorage.getItem(`${STORAGE_PREFIX}${userId || 'guest'}`);
  return THEME_OPTIONS.some(option => option.id === value) ? value as ThemeName : DEFAULT_THEME;
}

export function saveThemePreference(userId: string | null | undefined, theme: ThemeName): void {
  localStorage.setItem(`${STORAGE_PREFIX}${userId || 'guest'}`, theme);
}
