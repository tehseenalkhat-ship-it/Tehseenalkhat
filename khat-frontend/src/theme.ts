export type ThemeName = 'blue' | 'green' | 'gold' | 'maroon';

export const DEFAULT_THEME: ThemeName = 'gold';

export const THEME_OPTIONS: { id: ThemeName; label: string; colors: [string, string, string, string] }[] = [
  { id: 'blue', label: 'Blue', colors: ['#163d61', '#367fb0', '#86b8d0', '#e4eef3'] },
  { id: 'green', label: 'Green', colors: ['#145b57', '#238778', '#81b8a8', '#e5f1ed'] },
  { id: 'gold', label: 'Gold', colors: ['#704814', '#aa781f', '#d5b66f', '#f2e7ce'] },
  { id: 'maroon', label: 'Maroon', colors: ['#552538', '#91465d', '#c18898', '#f1e3e7'] },
];

const STORAGE_PREFIX = 'khat_theme:';

export function readThemePreference(userId?: string | null): ThemeName {
  const value = localStorage.getItem(`${STORAGE_PREFIX}${userId || 'guest'}`);
  return THEME_OPTIONS.some(option => option.id === value) ? value as ThemeName : DEFAULT_THEME;
}

export function saveThemePreference(userId: string | null | undefined, theme: ThemeName): void {
  localStorage.setItem(`${STORAGE_PREFIX}${userId || 'guest'}`, theme);
}
