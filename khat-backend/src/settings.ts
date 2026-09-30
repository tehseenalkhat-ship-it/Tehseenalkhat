import { pool } from './db.js';

export async function getSettingNumber(key: string, fallback: number): Promise<number> {
  const { rows } = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
  const value = rows[0]?.value;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}
