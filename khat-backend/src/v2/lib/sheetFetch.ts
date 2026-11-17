/** Fetches a Google Sheet tab as CSV text (sheet must be shared "Anyone with the link can view"). */
import { sheetUrlToCsvUrl } from './csv.js';

export class SheetFetchError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export const MAX_CSV_CHARS = 5_000_000;

export async function fetchSheetCsv(sheetUrl: string, preferredTab?: string): Promise<{ csv: string; label: string }> {
  const csvUrl = sheetUrlToCsvUrl(sheetUrl, preferredTab);
  if (!csvUrl) throw new SheetFetchError('That is not a Google Sheet link. Open the sheet, copy the link from the address bar and paste it here — or upload the tab as a CSV file.');
  let res: Response;
  try {
    res = await fetch(csvUrl, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new SheetFetchError('Could not reach Google Sheets. Please try again, or upload the tab as a CSV file.', 502);
  }
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (!res.ok || /text\/html/i.test(type) || /^\s*<(!doctype|html)/i.test(text)) {
    throw new SheetFetchError('Google would not share this sheet. In the sheet press Share → "Anyone with the link" → Viewer, then try again (or upload the tab as a CSV file).');
  }
  if (text.length > MAX_CSV_CHARS) throw new SheetFetchError('This sheet is too large to import in one go.', 413);
  return { csv: text, label: preferredTab ? `Google Sheet (${preferredTab} tab)` : 'Google Sheet' };
}
