import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowRight, Award, BarChart3, BookOpen, CalendarDays, Check, ChevronDown, ChevronRight,
  ClipboardList, FileText, FileImage, FileVideo, FileSpreadsheet, Images, LayoutDashboard, Lock, LogOut, Menu,
  MapPin, Play, Plus, RefreshCw, Search, Settings, ShieldCheck, Sparkles, Trash2, Trophy, Upload, Users, Download, Copy,
} from 'lucide-react';
import type { Script, LevelType } from '@/data/types';
import { khatTypes, scriptList, scriptToCode, scriptFromCode as mapScriptFromCode } from '@/data/mock';
import {
  navigate, Button, SectionHeading, StatusChip, StatCard, ScriptTabs,
  Modal, UploadBox, PenLoader,
} from '@/components/ui';
import { apiFetch, uploadFile, ApiError, clearSession, getSessionUser, getViewUrl } from '@/api';

type ApiMediaItem = { kind: 'video' | 'image' | 'pdf'; storageKey: string; originalFilename?: string };
type SheetSize = '1mm' | '2mm' | '3mm';
type ApiSheetFiles = Partial<Record<SheetSize, { storageKey: string; originalFilename?: string }>>;
type ApiLevel = {
  id: string; course_id: string; order_index: number; level_type: 'mufradat' | 'writing' | 'test';
  title: string; media: ApiMediaItem[]; sheet_files: ApiSheetFiles; badge_tier: string | null;
};
type ApiCourse = { id: string; khat_type_id: string; category: string; title: string; description?: string; is_deletable: boolean };
type ApiKhatType = { id: string; code: string; display_name: string };
type ApiCertTemplate = {
  id: string; khat_type_id: string; level_id: string | null; course_id: string | null; title: string; file_storage_key: string;
  course_title?: string | null; course_category?: string | null; level_title?: string | null; level_order_index?: number | null;
};
type BadgeTier = 'foundation' | 'composition' | 'mastery' | 'ijazah';
type ApiBadgeAsset = { key: string; storageKey: string; filename: string; mediaType: 'image' | 'pdf'; url?: string | null };
type ApiSiteSetting = { key: string; value: unknown };

type ApiBranch = { id: string; name: string };
type ApiStaffRow = { id: string; role: string; name: string; email: string; branch_id: string; is_coordinator: boolean; entry_load_threshold: number; photo_storage_key?: string | null };

function scriptFromCode(code: string): Script {
  return mapScriptFromCode(code) ?? 'Naskh';
}

function scriptCode(script: Script): string {
  return scriptToCode(script);
}

export function AdminLayout({ page }: { page: string }) {
  return (
    <div className="admin-shell">
      <div className="admin-main">
        <AdminContent page={page} />
      </div>
    </div>
  );
}

function AdminContent({ page }: { page: string }) {
  if (page === 'admin-courses') return <CourseBuilder />;
  if (page === 'admin-tr-numbers') return <TrNumberManager />;
  if (page === 'admin-logs') return <EntryLogs />;
  if (page === 'admin-users') return <TeacherLoadManagement />;
  if (page === 'admin-showcase') return <ShowcaseModeration />;
  if (page === 'admin-competitions') return <CompetitionsManager />;
  if (page === 'admin-events') return <EventsManager />;
  if (page === 'admin-resources') return <ResourceManager />;
  if (page === 'admin-stats') return <StatisticsDashboard />;
  if (page === 'admin-certificates') return <GovernanceManager section="certificates" />;
  if (page === 'admin-governance') return <GovernanceManager section="governance" />;
  return <AdminOverview />;
}

type ApiTrNumber = {
  tr_number: string;
  branch_id: string | null;
  used: boolean;
  student_id: string | null;
  imported_at: string;
};

function normalizeTrNumber(value: unknown): string | null {
  const trNumber = String(value ?? '').trim().toUpperCase();
  if (!trNumber || trNumber.length > 50 || !/[0-9]/.test(trNumber) || !/^[A-Z0-9-]+$/.test(trNumber)) return null;
  return trNumber;
}

function parseCsvMatrix(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value); value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(value); value = '';
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
    } else value += char;
  }
  row.push(value);
  if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}

async function parseXlsxMatrix(file: File): Promise<string[][]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readText = (data: Uint8Array) => new TextDecoder().decode(data);
  let endRecord = -1;
  for (let offset = Math.max(0, bytes.length - 65557); offset <= bytes.length - 22; offset++) {
    if (view.getUint32(offset, true) === 0x06054b50) endRecord = offset;
  }
  if (endRecord < 0) throw new Error('Invalid XLSX archive');
  const entryCount = view.getUint16(endRecord + 10, true);
  let directoryOffset = view.getUint32(endRecord + 16, true);
  const files = new Map<string, Uint8Array>();

  for (let index = 0; index < entryCount; index++) {
    if (view.getUint32(directoryOffset, true) !== 0x02014b50) throw new Error('Invalid XLSX directory');
    const method = view.getUint16(directoryOffset + 10, true);
    const compressedSize = view.getUint32(directoryOffset + 20, true);
    const nameLength = view.getUint16(directoryOffset + 28, true);
    const extraLength = view.getUint16(directoryOffset + 30, true);
    const commentLength = view.getUint16(directoryOffset + 32, true);
    const localOffset = view.getUint32(directoryOffset + 42, true);
    const name = readText(bytes.subarray(directoryOffset + 46, directoryOffset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    if (method === 0) files.set(name, compressed);
    else if (method === 8) {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      files.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    }
    directoryOffset += 46 + nameLength + extraLength + commentLength;
  }

  const xml = (path: string) => {
    const content = files.get(path);
    if (!content) return null;
    return new DOMParser().parseFromString(readText(content), 'application/xml');
  };
  const workbook = xml('xl/workbook.xml');
  const relationships = xml('xl/_rels/workbook.xml.rels');
  const firstSheet = workbook?.getElementsByTagName('sheet')[0];
  const relationshipId = firstSheet?.getAttribute('r:id') ?? firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const relationship = Array.from(relationships?.getElementsByTagName('Relationship') ?? []).find(item => item.getAttribute('Id') === relationshipId);
  const target = relationship?.getAttribute('Target') ?? 'worksheets/sheet1.xml';
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = xml(sheetPath);
  if (!sheet || sheet.getElementsByTagName('parsererror').length) throw new Error('Could not read the first worksheet');

  const sharedStringsDoc = xml('xl/sharedStrings.xml');
  const sharedStrings = Array.from(sharedStringsDoc?.getElementsByTagName('si') ?? []).map(item =>
    Array.from(item.getElementsByTagName('t')).map(text => text.textContent ?? '').join('')
  );
  const columnIndex = (reference: string) => {
    const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A';
    return [...letters].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  };
  return Array.from(sheet.getElementsByTagName('sheetData')[0]?.children ?? []).map(rowElement => {
    const row: string[] = [];
    for (const cell of Array.from(rowElement.children)) {
      const index = columnIndex(cell.getAttribute('r') ?? 'A');
      const type = cell.getAttribute('t');
      const value = cell.getElementsByTagName('v')[0]?.textContent ?? '';
      row[index] = type === 's' ? sharedStrings[Number(value)] ?? '' : type === 'inlineStr'
        ? Array.from(cell.getElementsByTagName('t')).map(text => text.textContent ?? '').join('')
        : value;
    }
    return row;
  });
}

async function spreadsheetMatrix(file: File): Promise<string[][]> {
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension === 'csv') return parseCsvMatrix(await file.text());
  if (extension === 'xlsx') return parseXlsxMatrix(file);
  throw new Error('Unsupported spreadsheet format');
}

function TrNumberManager() {
  const [numbers, setNumbers] = useState<ApiTrNumber[]>([]);
  const [branches, setBranches] = useState<ApiBranch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [parsedNumbers, setParsedNumbers] = useState<string[]>([]);
  const [invalidCount, setInvalidCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'available' | 'used'>('all');
  const [branchFilter, setBranchFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortAscending, setSortAscending] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, branchList] = await Promise.all([
        apiFetch<ApiTrNumber[]>('/admin/tr-numbers'),
        apiFetch<ApiBranch[]>('/branches'),
      ]);
      setNumbers(list);
      setBranches(branchList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load TR numbers.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const readSpreadsheet = async (file?: File) => {
    setError(null);
    setResult(null);
    setParsedNumbers([]);
    setInvalidCount(0);
    setDuplicateCount(0);
    if (!file) return;
    setFileName(file.name);

    try {
      const matrix = await spreadsheetMatrix(file);
      const candidates: string[] = [];
      let invalid = 0;
      const seen = new Set<string>();
      let duplicates = 0;

      if (matrix.length) {
        const headerRowIndex = matrix.slice(0, 8).findIndex(row => row.some(cell => {
          const header = String(cell ?? '').toLowerCase().replace(/[^a-z]/g, '');
          return ['tr', 'trnumber', 'trno', 'studenttr', 'registrationnumber', 'studentnumber'].includes(header);
        }));
        const sourceColumn = headerRowIndex >= 0
          ? matrix[headerRowIndex].findIndex(cell => ['tr', 'trnumber', 'trno', 'studenttr', 'registrationnumber', 'studentnumber'].includes(String(cell ?? '').toLowerCase().replace(/[^a-z]/g, '')))
          : 0;
        const firstDataRow = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;

        for (const row of matrix.slice(firstDataRow)) {
          const value = row[sourceColumn];
          if (String(value ?? '').trim() === '') continue;
          const normalized = normalizeTrNumber(value);
          if (!normalized) {
            invalid++;
            continue;
          }
          if (seen.has(normalized)) {
            duplicates++;
            continue;
          }
          seen.add(normalized);
          candidates.push(normalized);
        }
      }

      setParsedNumbers(candidates);
      setInvalidCount(invalid);
      setDuplicateCount(duplicates);
      if (!candidates.length) setError('No TR numbers found. Use a column headed “TR Number” or put one TR number per row in the first column.');
    } catch {
      setError('Could not read this file. Upload an Excel workbook (.xlsx) or a CSV file.');
    }
  };

  const importNumbers = async () => {
    if (!parsedNumbers.length) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiFetch<{ imported: number; skipped: number }>('/admin/tr-numbers', {
        method: 'POST',
        body: { trNumbers: parsedNumbers, ...(branchId ? { branchId } : {}) },
      });
      setResult(`${response.imported} TR number${response.imported === 1 ? '' : 's'} added; ${response.skipped} already existed and were skipped.`);
      setParsedNumbers([]);
      setFileName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not import TR numbers.');
    } finally {
      setImporting(false);
    }
  };

  const removeNumber = async (trNumber: string) => {
    if (!window.confirm(`Remove unused TR number ${trNumber}? This cannot be undone.`)) return;
    try {
      await apiFetch(`/admin/tr-numbers/${encodeURIComponent(trNumber)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this TR number.');
    }
  };

  const downloadTemplate = () => {
    const csv = '\uFEFFTR Number\nTR-20481\nTR-20482\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'student-tr-numbers-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const branchNames = Object.fromEntries(branches.map(branch => [branch.id, branch.name]));
  const filteredNumbers = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return numbers.filter(number => {
      const matchesSearch = !query || number.tr_number.toLowerCase().includes(query) || (branchNames[number.branch_id ?? ''] ?? 'Any branch').toLowerCase().includes(query);
      const matchesStatus = statusFilter === 'all' || (statusFilter === 'used' ? number.used : !number.used);
      const matchesBranch = branchFilter === 'all' || (branchFilter === 'unassigned' ? !number.branch_id : number.branch_id === branchFilter);
      return matchesSearch && matchesStatus && matchesBranch;
    }).sort((left, right) => left.tr_number.localeCompare(right.tr_number, undefined, { numeric: true }) * (sortAscending ? 1 : -1));
  }, [numbers, searchTerm, statusFilter, branchFilter, branchNames, sortAscending]);
  const pageCount = Math.max(1, Math.ceil(filteredNumbers.length / pageSize));
  const visibleNumbers = filteredNumbers.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => { setPage(current => Math.min(current, pageCount)); }, [pageCount]);

  const exportFilteredNumbers = () => {
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [
      ['TR Number', 'Branch', 'Status', 'Imported'],
      ...filteredNumbers.map(number => [number.tr_number, number.branch_id ? branchNames[number.branch_id] ?? 'Unknown branch' : 'Any branch', number.used ? 'Used' : 'Available', new Date(number.imported_at).toLocaleDateString()]),
    ];
    const csv = `\uFEFF${rows.map(row => row.map(quote).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'filtered-student-tr-numbers.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const copyFilteredNumbers = async () => {
    try {
      await navigator.clipboard.writeText(filteredNumbers.map(number => number.tr_number).join('\n'));
      setResult(`Copied ${filteredNumbers.length} filtered TR numbers to clipboard.`);
    } catch {
      setError('Clipboard access is unavailable. Use Export CSV to download these numbers.');
    }
  };

  return (
    <main className="page portal-page tr-number-admin-page">
      <SectionHeading eyebrow="Student access" title="TR number uploads" text="Import newly issued student TR numbers. A valid TR number authorizes signup; student email is collected separately for specialized notifications." />
      {error && <p className="error-text" role="alert">{error}</p>}
      {result && <p className="tr-import-success" role="status">{result}</p>}

      <section className="tr-import-card">
        <div className="tr-import-card-heading">
          <span className="tr-import-icon"><FileSpreadsheet size={21} /></span>
          <div><p className="eyebrow">Bulk import</p><h2>Upload a spreadsheet</h2><p>Excel (.xlsx) and CSV files are supported. Use a “TR Number” column or put one number per row in the first column.</p></div>
        </div>
        <label className="field-label">Assign branch <small className="muted">Optional · leave unassigned if the sheet contains multiple branches</small>
          <select className="field" value={branchId} onChange={event => setBranchId(event.target.value)}><option value="">No branch restriction</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>
        </label>
        <div className="tr-import-actions">
          <label className="tr-file-picker"><Upload size={17} /> Choose spreadsheet<input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={event => { void readSpreadsheet(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label>
          <button type="button" className="text-link" onClick={downloadTemplate}>Download CSV template</button>
        </div>
        {fileName && <p className="tr-selected-file"><FileSpreadsheet size={15} /> {fileName}</p>}
        {parsedNumbers.length > 0 && <div className="tr-import-preview"><div><strong>{parsedNumbers.length}</strong><span>unique TR numbers ready</span></div>{duplicateCount > 0 && <span>{duplicateCount} duplicate{duplicateCount === 1 ? '' : 's'} removed</span>}{invalidCount > 0 && <span>{invalidCount} invalid row{invalidCount === 1 ? '' : 's'} skipped</span>}</div>}
        <Button onClick={() => void importNumbers()} disabled={!parsedNumbers.length || importing}>{importing ? <PenLoader label="Importing TR numbers" compact tiny /> : 'Import TR numbers'} {!importing && <ArrowRight size={15} />}</Button>
      </section>

      <SectionHeading eyebrow="Signup eligibility" title="Imported TR numbers" text={`${numbers.length.toLocaleString()} total · ${numbers.filter(number => !number.used).length.toLocaleString()} available · ${numbers.filter(number => number.used).length.toLocaleString()} used`} action={<Button outline onClick={() => void load()}><RefreshCw size={14} /> Refresh</Button>} />
      <div className="tr-number-tools" role="search">
        <label className="tr-number-search"><Search size={16} /><input value={searchTerm} onChange={event => { setSearchTerm(event.target.value); setPage(1); }} placeholder="Search TR number or branch…" aria-label="Search TR numbers or branches" />{searchTerm && <button type="button" onClick={() => { setSearchTerm(''); setPage(1); }} aria-label="Clear search">×</button>}</label>
        <label className="tr-filter-label">Status<select className="field" value={statusFilter} onChange={event => { setStatusFilter(event.target.value as typeof statusFilter); setPage(1); }}><option value="all">All statuses</option><option value="available">Available</option><option value="used">Used</option></select></label>
        <label className="tr-filter-label">Branch<select className="field" value={branchFilter} onChange={event => { setBranchFilter(event.target.value); setPage(1); }}><option value="all">All branches</option><option value="unassigned">Any branch</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <div className="tr-number-export-actions"><button type="button" className="text-link" onClick={() => void copyFilteredNumbers()} disabled={!filteredNumbers.length}><Copy size={14} /> Copy list</button><button type="button" className="text-link" onClick={exportFilteredNumbers} disabled={!filteredNumbers.length}><Download size={14} /> Export CSV</button></div>
      </div>
      <div className="tr-number-list-summary"><span>Showing <strong>{filteredNumbers.length ? ((page - 1) * pageSize + 1).toLocaleString() : 0}–{Math.min(page * pageSize, filteredNumbers.length).toLocaleString()}</strong> of <strong>{filteredNumbers.length.toLocaleString()}</strong> matching records</span><label>Rows per page<select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option></select></label></div>
      <div className="teacher-table governance-table tr-number-table">
        <div className="table-head"><span>#</span><button type="button" className="tr-sort-button" onClick={() => setSortAscending(value => !value)}>TR number {sortAscending ? '↑' : '↓'}</button><span>Branch</span><span>Status</span><span>Imported</span><span>Action</span></div>
        {loading ? <div className="governance-empty">Loading TR numbers…</div> : numbers.length === 0 ? <div className="governance-empty"><span><FileSpreadsheet size={18} /></span><div><strong>No TR numbers imported</strong><p>Upload the current admissions spreadsheet to open student signup for eligible students.</p></div></div> : filteredNumbers.length === 0 ? <div className="governance-empty"><span><Search size={18} /></span><div><strong>No matching TR numbers</strong><p>Try another search term or clear one of the filters.</p></div></div> : visibleNumbers.map((number, index) => (
          <div className="history-row" key={number.tr_number}>
            <span className="tr-row-index" aria-label={`Row ${(page - 1) * pageSize + index + 1}`}>{((page - 1) * pageSize + index + 1).toLocaleString()}</span>
            <span data-label="TR number"><strong>{number.tr_number}</strong></span>
            <span data-label="Branch">{number.branch_id ? branchNames[number.branch_id] ?? 'Branch' : 'Any branch'}</span>
            <span data-label="Status"><StatusChip tone={number.used ? 'green' : 'blue'}>{number.used ? 'Used' : 'Available'}</StatusChip></span>
            <span data-label="Imported">{new Date(number.imported_at).toLocaleDateString()}</span>
            <span data-label="Action">{!number.used && <button className="text-link danger" onClick={() => void removeNumber(number.tr_number)}><Trash2 size={14} /> Remove</button>}</span>
          </div>
        ))}
      </div>
      {!loading && filteredNumbers.length > 0 && <div className="tr-number-pagination"><span>Page {page.toLocaleString()} of {pageCount.toLocaleString()}</span><div><Button outline disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</Button><Button outline disabled={page >= pageCount} onClick={() => setPage(value => Math.min(pageCount, value + 1))}>Next</Button></div></div>}
    </main>
  );
}

function AdminOverview() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [studentCount, setStudentCount] = useState(0);
  const [teacherCount, setTeacherCount] = useState(0);
  const [certificatesIssued, setCertificatesIssued] = useState(0);
  const [entriesReviewed, setEntriesReviewed] = useState(0);
  const [activeCompetitions, setActiveCompetitions] = useState(0);
  const [pendingEntries, setPendingEntries] = useState(0);
  const [showcaseWaiting, setShowcaseWaiting] = useState(0);
  const [branchCounts, setBranchCounts] = useState<{ id: string; name: string; count: number }[]>([]);
  const [attention, setAttention] = useState<{ label: string }[]>([]);
  const [studentPreview, setStudentPreview] = useState<{ id: string; name: string; branch_id: string; photo_storage_key?: string | null; photoStorageKey?: string | null }[]>([]);
  const [teacherPreview, setTeacherPreview] = useState<ApiStaffRow[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        setError(null);
        const [studentsList, certsApproved, entriesReviewedList, competitionsList, branchList, allEntries, showcasePending, teachersList] = await Promise.all([
          apiFetch<{ id: string; name: string; branch_id: string; photo_storage_key?: string | null; photoStorageKey?: string | null }[]>('/students'),
          apiFetch<{ id: string }[]>('/certificates?status=approved'),
          apiFetch<{ id: string }[]>('/entries?status=reviewed'),
          apiFetch<{ id: string; status: string }[]>('/competitions'),
          apiFetch<ApiBranch[]>('/branches'),
          apiFetch<{ id: string; status: string; idle_flagged: boolean }[]>('/entries'),
          apiFetch<{ id: string }[]>('/showcase/pending'),
          apiFetch<ApiStaffRow[]>('/admin/users?role=teacher'),
        ]);

        setStudentCount(studentsList.length);
        setTeacherCount(teachersList.length);
        setStudentPreview(studentsList.slice(0, 5));
        setTeacherPreview(teachersList.slice(0, 5));
        setCertificatesIssued(certsApproved.length);
        setEntriesReviewed(entriesReviewedList.length);
        setActiveCompetitions(competitionsList.filter(c => c.status === 'open' || c.status === 'upcoming' || c.status === 'judging').length);

        const counts = await Promise.all(branchList.map(async b => ({
          id: b.id,
          name: b.name,
          count: (await apiFetch<{ id: string }[]>(`/students?branchId=${b.id}`)).length,
        })));
        setBranchCounts(counts);

        const pendingCount = allEntries.filter(e => e.status === 'pending').length;
        const idleCount = allEntries.filter(e => e.idle_flagged).length;
        setPendingEntries(pendingCount);
        setShowcaseWaiting(showcasePending.length);
        const items: { label: string }[] = [];
        if (pendingCount > 0) items.push({ label: `${pendingCount} ${pendingCount === 1 ? 'entry is' : 'entries are'} waiting for a teacher` });
        if (showcasePending.length > 0) items.push({ label: `${showcasePending.length} showcase post${showcasePending.length === 1 ? '' : 's'} need moderation` });
        if (idleCount > 0) items.push({ label: `${idleCount} idle-flagged ${idleCount === 1 ? 'entry needs' : 'entries need'} manual reassignment` });
        setAttention(items);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load the admin overview.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const maxBranch = Math.max(1, ...branchCounts.map(b => b.count));
  const user = getSessionUser();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const branchNameById = Object.fromEntries(branchCounts.map(b => [b.id, b.name]));

  return (
    <>
      <SectionHeading eyebrow={`${greeting}, ${user?.name?.split(' ')[0] ?? 'administrator'}`} title="Guild overview" text="A clear view of learning, teaching, and the work between." />
      {loading && <p className="muted">Loading overview…</p>}
      {error && <div className="admin-error-banner" role="alert"><span>{error}</span><Button outline onClick={() => window.location.reload()}>Reload</Button></div>}
      <div className="stats-grid admin-stat-grid admin-overview-stat-grid">
        <StatCard icon={Users} value={String(studentCount)} label="Enrolled students" />
        <StatCard icon={BookOpen} value={String(teacherCount)} label="Teachers across branches" />
        <StatCard icon={Award} value={String(certificatesIssued)} label="Certificates issued" />
        <StatCard icon={ClipboardList} value={String(entriesReviewed)} label="Entries reviewed" />
        <StatCard icon={Trophy} value={String(activeCompetitions)} label="Active competitions" />
        <StatCard icon={Activity} value={String(pendingEntries)} label="Entries awaiting review" />
        <StatCard icon={Images} value={String(showcaseWaiting)} label="Showcase posts to moderate" />
        <StatCard icon={MapPin} value={String(branchCounts.length)} label="Active branches" />
      </div>
      <div className="admin-dashboard-grid">
        <div className="chart-card">
          <SectionHeading title="Branch pulse" text="Students enrolled per branch" />
          <div className="branch-bars">
            {branchCounts.map(b => (
              <div key={b.name}><span>{b.name}</span><div><i style={{ width: `${(b.count / maxBranch) * 100}%` }} /></div><strong>{b.count}</strong></div>
            ))}
          </div>
        </div>
        <div className="admin-queue">
          <SectionHeading title="Needs attention" action={<button className="text-link" onClick={() => navigate('admin-users')}>Manage capacity <ArrowRight size={15} /></button>} />
          {attention.length === 0 && !loading && <div className="admin-attention-empty"><span><Check size={16} /></span><div><strong>All caught up</strong><small>Nothing needs attention right now.</small></div></div>}
          {attention.map((item, i) => (
            <div className="admin-attention-item" key={item.label}><span className={`attention-dot dot-${i % 3}`} /><strong>{item.label}</strong><ChevronRight size={15} /></div>
          ))}
        </div>
      </div>
      <section className="admin-people-showcase">
        <div className="admin-people-heading"><div><p className="eyebrow">Our community</p><h2>Students & teachers</h2><p>People building the guild across every branch.</p></div><button className="text-link" onClick={() => navigate('admin-governance')}>Manage records <ArrowRight size={15} /></button></div>
        <div className="admin-people-columns">
          <div><h3>Students <span>{studentCount}</span></h3>
            {studentPreview.length ? studentPreview.map(student => <div className="admin-person-row" key={student.id}><GovernanceAvatar name={student.name} storageKey={student.photo_storage_key ?? student.photoStorageKey} className="admin-person-avatar" /><strong>{student.name}</strong><small>{branchNameById[student.branch_id] ?? 'Branch'}</small></div>) : <p className="muted">{loading ? 'Loading students…' : 'No students to show yet.'}</p>}
          </div>
          <div><h3>Teachers <span>{teacherCount}</span></h3>
            {teacherPreview.length ? teacherPreview.map(teacher => <div className="admin-person-row" key={teacher.id}><GovernanceAvatar name={teacher.name} storageKey={teacher.photo_storage_key} className="admin-person-avatar teacher" /><strong>{teacher.name}</strong><small>{branchNameById[teacher.branch_id] ?? 'Branch'}{teacher.is_coordinator ? ' · Coordinator' : ''}</small></div>) : <p className="muted">{loading ? 'Loading teachers…' : 'No teachers to show yet.'}</p>}
          </div>
        </div>
      </section>
    </>
  );
}

function CourseBuilder() {
  const [script, setScript] = useState<Script>('Naskh');
  const [courseType, setCourseType] = useState<'certification' | 'secondary'>('certification');
  const [khatType, setKhatType] = useState<ApiKhatType | null>(null);
  const [course, setCourse] = useState<ApiCourse | null>(null);
  const [courseChoices, setCourseChoices] = useState<ApiCourse[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [levels, setLevels] = useState<ApiLevel[]>([]);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draggedLevelId, setDraggedLevelId] = useState<string | null>(null);

  const [showAddLevel, setShowAddLevel] = useState(false);
  const [newLevelType, setNewLevelType] = useState<LevelType>('practice');
  const [insertAfterLevelId, setInsertAfterLevelId] = useState('__end__');
  const [showNewCourse, setShowNewCourse] = useState(false);
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newCourseDesc, setNewCourseDesc] = useState('');

  // Draft state for whichever level is selected — edits happen here, then "Save changes" persists it.
  const [titleDraft, setTitleDraft] = useState('');
  const [mediaDraft, setMediaDraft] = useState<ApiMediaItem[]>([]);
  const [sheetDraft, setSheetDraft] = useState<ApiSheetFiles>({});
  const [badgeTierDraft, setBadgeTierDraft] = useState('');

  const level = levels.find(l => l.id === selectedLevelId) ?? null;
  const isCheckpoint = level?.level_type === 'test';
  const levelIndex = level ? levels.findIndex(l => l.id === level.id) : -1;

  const loadEverything = async (preferredCourseId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const khatTypesList = await apiFetch<ApiKhatType[]>('/khat-types');
      const kt = khatTypesList.find(k => k.code === scriptCode(script)) ?? null;
      setKhatType(kt);
      if (!kt) { setLoading(false); return; }

      let [certCourses, secCourses] = await Promise.all([
        apiFetch<ApiCourse[]>(`/courses?khatTypeId=${kt.id}&category=certification`),
        apiFetch<ApiCourse[]>(`/courses?khatTypeId=${kt.id}&category=secondary`),
      ]);

      if (courseType === 'certification' && certCourses.length === 0) {
        try {
          await apiFetch<ApiCourse>('/courses', {
            method: 'POST',
            body: {
              khatTypeId: kt.id,
              category: 'certification',
              title: `${khatTypes[script].name} certification course`,
              description: `The ${khatTypes[script].name} certification path.`,
            },
          });
        } catch (createErr) {
          // Another admin may have created the unique certification course concurrently.
          if (!(createErr instanceof ApiError) || createErr.status !== 409) throw createErr;
        }
        certCourses = await apiFetch<ApiCourse[]>(`/courses?khatTypeId=${kt.id}&category=certification`);
      }

      const availableCourses = courseType === 'certification' ? certCourses : secCourses;
      setCourseChoices(availableCourses);
      const preferredId = preferredCourseId ?? selectedCourseId;
      const activeCourse = courseType === 'certification'
        ? (certCourses[0] ?? null)
        : (availableCourses.find(item => item.id === preferredId) ?? availableCourses[0] ?? null);
      setSelectedCourseId(activeCourse?.id ?? null);
      setCourse(activeCourse);
      if (activeCourse) {
        const levelList = await apiFetch<ApiLevel[]>(`/courses/${activeCourse.id}/levels`);
        setLevels(levelList);
        setSelectedLevelId(levelList[0]?.id ?? null);
      } else {
        setLevels([]);
        setSelectedLevelId(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load course data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setSelectedCourseId(null); loadEverything(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [script, courseType]);

  useEffect(() => {
    if (level) {
      setTitleDraft(level.title);
      setMediaDraft(level.media);
      setSheetDraft(level.sheet_files);
      setBadgeTierDraft(level.badge_tier ?? '');
    }
  }, [level?.id]);

  const addMediaRef = (kind: 'video' | 'image' | 'pdf') => setMediaDraft([...mediaDraft, { kind, storageKey: '' }]);
  const removeMediaRef = (i: number) => setMediaDraft(mediaDraft.filter((_, idx) => idx !== i));
  const uploadMediaAt = async (i: number, file: File) => {
    const { storageKey, originalFilename } = await uploadFile('levels', file);
    setMediaDraft(mediaDraft.map((m, idx) => (idx === i ? { ...m, storageKey, originalFilename } : m)));
  };
  const uploadSheetAt = async (size: SheetSize, file: File) => {
    const { storageKey, originalFilename } = await uploadFile('sheets', file);
    setSheetDraft({ ...sheetDraft, [size]: { storageKey, originalFilename } });
  };

  const saveLevel = async () => {
    if (!level) return;
    setSaving(true);
    try {
      await apiFetch(`/levels/${level.id}`, {
        method: 'PUT',
        body: { title: titleDraft, media: mediaDraft, sheetFiles: sheetDraft, badgeTier: badgeTierDraft || undefined },
      });
      await loadEverything();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save this level.');
    } finally {
      setSaving(false);
    }
  };

  const addLevel = async () => {
    if (!course) return;
    try {
      const created = await apiFetch<ApiLevel>(`/courses/${course.id}/levels`, {
        method: 'POST',
        body: { levelType: newLevelType === 'checkpoint' ? 'test' : 'mufradat', title: newLevelType === 'checkpoint' ? 'New checkpoint test' : 'New practice level' },
      });
      const orderedIds = levels.map(item => item.id);
      const insertionIndex = insertAfterLevelId === '__start__'
        ? 0
        : insertAfterLevelId === '__end__'
          ? orderedIds.length
          : Math.max(0, orderedIds.indexOf(insertAfterLevelId) + 1);
      orderedIds.splice(insertionIndex, 0, created.id);
      const reordered = await apiFetch<ApiLevel[]>(`/courses/${course.id}/levels/reorder`, {
        method: 'PATCH', body: { orderedLevelIds: orderedIds },
      });
      setLevels(reordered);
      setSelectedLevelId(created.id);
      setShowAddLevel(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add or position this level.');
      await loadEverything();
    }
  };

  const moveLevel = async (levelId: string, beforeLevelId: string) => {
    if (!course || levelId === beforeLevelId) return;
    const orderedIds = levels.map(item => item.id).filter(id => id !== levelId);
    const targetIndex = orderedIds.indexOf(beforeLevelId);
    orderedIds.splice(targetIndex < 0 ? orderedIds.length : targetIndex, 0, levelId);
    try {
      const reordered = await apiFetch<ApiLevel[]>(`/courses/${course.id}/levels/reorder`, {
        method: 'PATCH', body: { orderedLevelIds: orderedIds },
      });
      setLevels(reordered);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reorder course levels.');
    }
  };

  const deleteLevel = async () => {
    if (!level) return;
    if (!window.confirm(`Delete “${level.title}”? This is only allowed if no student submissions, checkpoint entries, certificates, or certificate assignments depend on it.`)) return;
    try {
      await apiFetch(`/levels/${level.id}`, { method: 'DELETE' });
      setShowAddLevel(false);
      await loadEverything();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete this level.');
    }
  };

  const openAddLevel = () => {
    setInsertAfterLevelId(selectedLevelId ?? '__end__');
    setShowAddLevel(true);
  };

  const selectCourse = async (courseId: string) => {
    const selected = courseChoices.find(item => item.id === courseId);
    if (!selected) return;
    setSelectedCourseId(selected.id);
    setCourse(selected);
    setLevels([]);
    setSelectedLevelId(null);
    try {
      const levelList = await apiFetch<ApiLevel[]>(`/courses/${selected.id}/levels`);
      setLevels(levelList);
      setSelectedLevelId(levelList[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this course.');
    }
  };

  const createCourse = async () => {
    if (!khatType || !newCourseTitle.trim()) return;
    try {
      const created = await apiFetch<ApiCourse>('/courses', {
        method: 'POST',
        body: { khatTypeId: khatType.id, category: courseType, title: newCourseTitle.trim(), description: newCourseDesc.trim() },
      });
      setShowNewCourse(false);
      setNewCourseTitle('');
      setNewCourseDesc('');
      setSelectedCourseId(created.id);
      await loadEverything(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create the course.');
    }
  };

  const deleteCourse = async () => {
    if (!course) return;
    if (!window.confirm(`Delete “${course.title}” and all its levels and attached content? This cannot be undone.`)) return;
    try {
      await apiFetch(`/courses/${course.id}`, { method: 'DELETE' });
      const remaining = courseChoices.filter(item => item.id !== course.id);
      const nextCourseId = remaining[0]?.id ?? null;
      setSelectedCourseId(nextCourseId);
      await loadEverything(nextCourseId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete this course.');
    }
  };

  return (
    <>
      <SectionHeading eyebrow="Curriculum control" title="Course Builder" text="Shape the levels, references, and practice sheets for every hand." />
      <div className="builder-toolbar">
        <ScriptTabs script={script} setScript={setScript} />
        <div className="tabs small">
          <button className={courseType === 'certification' ? 'active' : ''} onClick={() => { setShowNewCourse(false); setCourseType('certification'); }}>Certification</button>
          <button className={courseType === 'secondary' ? 'active' : ''} onClick={() => setCourseType('secondary')}>Secondary</button>
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
      {loading && <PenLoader label="Loading course builder…" compact />}
      {courseType === 'certification' && course && (
        <div className="info-banner"><Lock size={16} /><span>Certification courses cannot be deleted. You can add, reorder, and remove unused levels; each checkpoint locks later levels until passed.</span></div>
      )}

      {courseType === 'secondary' && (
        <div className="secondary-course-controls">
          {courseChoices.length > 0 && (
            <label className="field-label">Secondary course
              <select className="field" value={selectedCourseId ?? ''} onChange={event => void selectCourse(event.target.value)}>
                {courseChoices.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
          )}
          <Button outline onClick={() => setShowNewCourse(value => !value)}><Plus size={15} /> {showNewCourse ? 'Cancel' : 'Add secondary course'}</Button>
        </div>
      )}

      {showNewCourse && courseType === 'secondary' && (
        <div className="builder-editor new-course-form">
          <div className="editor-heading"><div><p className="eyebrow">New {courseType} course</p><h2>Create a course</h2></div></div>
          <label className="field-label">Course title<input className="field" value={newCourseTitle} onChange={event => setNewCourseTitle(event.target.value)} placeholder="Course title" /></label>
          <label className="field-label">Description<input className="field" value={newCourseDesc} onChange={event => setNewCourseDesc(event.target.value)} placeholder="Short course description" /></label>
          <Button onClick={createCourse} disabled={!newCourseTitle.trim()}><Plus size={15} /> Create course</Button>
        </div>
      )}

      {!loading && !course && (
        <div className="builder-editor">
          <p className="muted">No {courseType} course exists yet for {khatTypes[script].name}.</p>
          {courseType === 'certification' && <p className="muted">Preparing the certification course… refresh this page if it does not appear.</p>}
        </div>
      )}

      {!loading && course && (
        <div className="builder-grid">
          <div className="builder-levels">
            {levels.map((l, i) => (
              <button
                className={`${selectedLevelId === l.id ? 'active' : ''}${draggedLevelId === l.id ? ' is-dragging' : ''}`}
                key={l.id}
                draggable
                onClick={() => setSelectedLevelId(l.id)}
                onDragStart={event => { setDraggedLevelId(l.id); event.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={event => event.preventDefault()}
                onDrop={event => { event.preventDefault(); if (draggedLevelId) void moveLevel(draggedLevelId, l.id); setDraggedLevelId(null); }}
                onDragEnd={() => setDraggedLevelId(null)}
                title="Drag to reorder this level"
              >
                <span>{l.level_type === 'test' ? '◆' : '⠿'}</span>
                <strong>Level {i + 1}</strong>
                <small>{l.title}{l.level_type === 'test' ? ' · Checkpoint test' : ''}</small>
                <ChevronRight size={15} />
              </button>
            ))}
            <button className="add-level-btn" onClick={openAddLevel}><Plus size={16} /> Add level</button>
            {courseType === 'secondary' && <button className="delete-course-btn" onClick={deleteCourse}><Trash2 size={15} /> Delete course</button>}
          </div>
          <div className="builder-editor">
            {showAddLevel ? (
              <>
                <div className="editor-heading"><div><p className="eyebrow">New level</p><h2>Choose level type</h2></div></div>
                <label className="field-label">Add level position
                  <select className="field" value={insertAfterLevelId} onChange={event => setInsertAfterLevelId(event.target.value)}>
                    <option value="__start__">At the beginning</option>
                    {levels.map((existingLevel, index) => <option key={existingLevel.id} value={existingLevel.id}>After level {index + 1} · {existingLevel.title}</option>)}
                    <option value="__end__">At the end</option>
                  </select>
                </label>
                <div className="level-type-choice">
                  <button className={newLevelType === 'practice' ? 'active' : ''} onClick={() => setNewLevelType('practice')}>
                    <BookOpen size={20} /><strong>Practice level</strong>
                    <small>Video/image references + practice sheets. Unlocks next level immediately on upload.</small>
                  </button>
                  <button className={newLevelType === 'checkpoint' ? 'active' : ''} onClick={() => setNewLevelType('checkpoint')}>
                    <ClipboardList size={20} /><strong>Checkpoint test</strong>
                    <small>Reference images of exact letters/text to copy. Teacher-reviewed. Gates progression.</small>
                  </button>
                </div>
                <div className="level-editor-actions">
                  <Button onClick={addLevel}>Create {newLevelType === 'checkpoint' ? 'checkpoint test' : 'practice level'} <ArrowRight size={15} /></Button>
                  <Button outline onClick={() => setShowAddLevel(false)}>Cancel</Button>
                </div>
              </>
            ) : level ? (
              <>
                <div className="editor-heading">
                  <div><p className="eyebrow">Editing level {String(levelIndex + 1).padStart(2, '0')}</p><h2>{level.title}</h2></div>
                  <div className="level-editor-heading-actions">
                    <StatusChip tone="green">Published</StatusChip>
                    <button className="text-link danger" onClick={deleteLevel}><Trash2 size={14} /> Delete level</button>
                  </div>
                </div>
                <label className="field-label">Level title<input className="field" value={titleDraft} onChange={e => setTitleDraft(e.target.value)} /></label>

                <div className="editor-section">
                  <p className="eyebrow">{isCheckpoint ? 'Reference images — exact letters/text to copy' : 'Reference media — uploaded files'}</p>
                  <p className="editor-hint">{isCheckpoint ? 'Upload images of the exact letters and text the student must replicate. No typed text — the student copies precisely what is in the image.' : 'Upload video and image references. Each file is a real upload — no pasted URLs.'}</p>
                  {mediaDraft.map((ref, i) => (
                    <div className="file-upload-row" key={i}>
                      <UploadBox
                        label={ref.originalFilename ?? `Upload ${ref.kind} reference`}
                        sublabel={ref.kind === 'video' ? 'Video · drag and drop or browse' : ref.kind === 'pdf' ? 'PDF · drag and drop or browse' : 'Image · drag and drop or browse'}
                        icon={ref.kind === 'video' ? FileVideo : ref.kind === 'pdf' ? FileText : FileImage}
                        accept={ref.kind === 'video' ? 'video/*' : ref.kind === 'pdf' ? '.pdf,application/pdf' : 'image/*'}
                        onChange={file => uploadMediaAt(i, file)}
                      />
                      <button className="text-link danger" onClick={() => removeMediaRef(i)}><Trash2 size={14} /></button>
                    </div>
                  ))}
                  <div className="add-media-row">
                    {isCheckpoint ? (
                      <>
                        <button className="text-link" onClick={() => addMediaRef('image')}><Plus size={15} /> Add reference image</button>
                        <button className="text-link" onClick={() => addMediaRef('pdf')}><Plus size={15} /> Add reference PDF</button>
                      </>
                    ) : (
                      <>
                        <button className="text-link" onClick={() => addMediaRef('video')}><Plus size={15} /> Add video reference</button>
                        <button className="text-link" onClick={() => addMediaRef('image')}><Plus size={15} /> Add image reference</button>
                        <button className="text-link" onClick={() => addMediaRef('pdf')}><Plus size={15} /> Add PDF reference</button>
                      </>
                    )}
                  </div>
                </div>

                <div className="editor-section">
                  <p className="eyebrow">Practice sheets — one file per grid size</p>
                  <div className="sheet-upload-row">
                    {(['1mm', '2mm', '3mm'] as SheetSize[]).map(size => (
                      <UploadBox key={size} label={sheetDraft[size]?.originalFilename ?? `${size} grid sheet`} sublabel={`${size} sheet · image or PDF · drag and drop or browse`} accept="image/*,.pdf,application/pdf" onChange={file => uploadSheetAt(size, file)} />
                    ))}
                  </div>
                </div>

                {isCheckpoint && (
                  <label className="field-label checkpoint-badge-field">Badge tier awarded on pass
                    <select className="field" value={badgeTierDraft} onChange={e => setBadgeTierDraft(e.target.value)}>
                      <option value="">None</option>
                      <option value="foundation">Foundation</option>
                      <option value="composition">Composition</option>
                      <option value="mastery">Mastery</option>
                      <option value="ijazah">Ijāzah</option>
                    </select>
                  </label>
                )}

                <Button className="course-level-save" onClick={saveLevel}>{saving ? <PenLoader label="Saving changes" compact tiny /> : 'Save changes'} {!saving && <Check size={15} />}</Button>
              </>
            ) : (
              <p className="muted">No levels yet — add one to get started.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

type ApiEntryRow = {
  id: string; status: string; student_name: string; student_branch_id: string; khat_type_id: string | null;
  assigned_teacher_id: string | null; created_at: string;
};

function TeacherLoadManagement() {
  const [showOverflow, setShowOverflow] = useState(false);
  const [staff, setStaff] = useState<ApiStaffRow[]>([]);
  const [adminStaff, setAdminStaff] = useState<ApiStaffRow[]>([]);
  const [branchList, setBranchList] = useState<ApiBranch[]>([]);
  const [teacherBranchFilter, setTeacherBranchFilter] = useState('all');
  const [assignedScripts, setAssignedScripts] = useState<Record<string, Script[]>>({});
  const [branchMap, setBranchMap] = useState<Record<string, string>>({});
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [entries, setEntries] = useState<ApiEntryRow[]>([]);
  const [thresholdDrafts, setThresholdDrafts] = useState<Record<string, string>>({});
  const [adminBranchDrafts, setAdminBranchDrafts] = useState<Record<string, string>>({});
  const [assignDrafts, setAssignDrafts] = useState<Record<string, string>>({});
  const [createRole, setCreateRole] = useState<'teacher' | 'admin'>('teacher');
  const [createName, setCreateName] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createBranchId, setCreateBranchId] = useState('');
  const [createIsCoordinator, setCreateIsCoordinator] = useState(false);
  const [createKhatTypeIds, setCreateKhatTypeIds] = useState<string[]>([]);
  const [createdAccount, setCreatedAccount] = useState<{ email: string; tempPassword: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [staffList, adminList, branchList, khatList, entriesList] = await Promise.all([
        apiFetch<ApiStaffRow[]>('/admin/users?role=teacher'),
        apiFetch<ApiStaffRow[]>('/admin/users?role=admin'),
        apiFetch<ApiBranch[]>('/branches'),
        apiFetch<ApiKhatType[]>('/khat-types'),
        apiFetch<ApiEntryRow[]>('/entries'),
      ]);
      setStaff(staffList);
      setAdminStaff(adminList);
      setBranchList(branchList);
      setBranchMap(Object.fromEntries(branchList.map(b => [b.id, b.name])));
      setKhatTypesList(khatList);
      setEntries(entriesList);
      setThresholdDrafts(Object.fromEntries(staffList.map(t => [t.id, String(t.entry_load_threshold)])));
      setAdminBranchDrafts(Object.fromEntries(adminList.map(admin => [admin.id, admin.branch_id])));

      if (!createBranchId && branchList[0]) {
        setCreateBranchId(branchList[0].id);
      }

      const scriptsByTeacher = await Promise.all(staffList.map(async t => {
        const profile = await apiFetch<{ assignedScripts: { code: string }[] }>(`/teachers/${t.id}/profile`).catch(() => ({ assignedScripts: [] }));
        return [t.id, profile.assignedScripts.map(s => scriptFromCode(s.code))] as const;
      }));
      setAssignedScripts(Object.fromEntries(scriptsByTeacher));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load teacher data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleCreateKhatType = (khatTypeId: string) => {
    setCreateKhatTypeIds(prev => prev.includes(khatTypeId) ? prev.filter(id => id !== khatTypeId) : [...prev, khatTypeId]);
  };

  const createAccount = async () => {
    if (!createName.trim() || !createEmail.trim() || !createBranchId) {
      setError('Name, email, and branch are required.');
      return;
    }

    try {
      const response = await apiFetch<{ tempPassword?: string; email: string; name: string; role: string }>(`/admin/users`, {
        method: 'POST',
        body: {
          role: createRole,
          name: createName.trim(),
          email: createEmail.trim(),
          branchId: createBranchId,
          isCoordinator: createRole === 'teacher' ? createIsCoordinator : undefined,
          ...(createRole === 'teacher' && createKhatTypeIds.length ? { khatTypeIds: createKhatTypeIds } : {}),
        },
      });

      setCreatedAccount(response.tempPassword ? { email: response.email, tempPassword: response.tempPassword } : null);
      setCreateName('');
      setCreateEmail('');
      setCreateIsCoordinator(false);
      setCreateKhatTypeIds([]);
      setCreateRole('teacher');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create the account.');
    }
  };

  const toggleScript = async (teacherId: string, script: Script) => {
    const current = assignedScripts[teacherId] ?? [];
    const next = current.includes(script) ? current.filter(s => s !== script) : [...current, script];
    setAssignedScripts(prev => ({ ...prev, [teacherId]: next }));
    try {
      const khatTypeIds = next.map(s => khatTypesList.find(k => k.code === scriptCode(s))?.id).filter(Boolean) as string[];
      await apiFetch(`/admin/users/${teacherId}/khat-types`, { method: 'PUT', body: { khatTypeIds } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update assignment.');
      load();
    }
  };

  const saveThreshold = async (teacherId: string) => {
    const value = Number(thresholdDrafts[teacherId]);
    if (!value || value < 1) return;
    try {
      await apiFetch(`/admin/users/${teacherId}`, { method: 'PUT', body: { entryLoadThreshold: value } });
      setStaff(prev => prev.map(t => t.id === teacherId ? { ...t, entry_load_threshold: value } : t));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update threshold.');
    }
  };

  const saveAdminBranch = async (adminId: string) => {
    const branchId = adminBranchDrafts[adminId];
    if (!branchId) return;
    try {
      await apiFetch(`/admin/users/${adminId}`, { method: 'PUT', body: { branchId } });
      setAdminStaff(prev => prev.map(admin => admin.id === adminId ? { ...admin, branch_id: branchId } : admin));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update administrator branch.');
    }
  };

  const loadFor = (teacherId: string) => entries.filter(e => e.assigned_teacher_id === teacherId && (e.status === 'assigned' || e.status === 'in_review')).length;
  const overflow = entries.filter(e => e.status === 'pending');

  const assignOverflow = async (entryId: string) => {
    const teacherId = assignDrafts[entryId];
    if (!teacherId) return;
    try {
      await apiFetch(`/entries/${entryId}/divert`, { method: 'POST', body: { teacherId, reason: 'Manually assigned from overflow queue' } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign this entry.');
    }
  };

  const activeCount = staff.length;
  const avgCapacity = activeCount > 0 ? Math.round((staff.reduce((sum, t) => sum + (loadFor(t.id) / Math.max(1, t.entry_load_threshold)), 0) / activeCount) * 100) : 0;
  const filteredStaff = teacherBranchFilter === 'all' ? staff : staff.filter(teacher => teacher.branch_id === teacherBranchFilter);

  return (
    <div className="teacher-load-page">
      <SectionHeading eyebrow="People & capacity" title="Teacher & Load Management" text="Assign khat types, balance the queue, and divert overflow — all from one place." />
      {error && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading…</p>}
      <div className="admin-form-card">
        <h3>Create staff account</h3>
        <div className="form-row">
          <label className="field-label">Role
            <select className="field" value={createRole} onChange={e => setCreateRole(e.target.value as 'teacher' | 'admin')}>
              <option value="teacher">Teacher</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label className="field-label">Branch
            <select className="field" value={createBranchId} onChange={e => setCreateBranchId(e.target.value)}>
              <option value="">Select branch</option>
              {branchList.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
        </div>

        <div className="form-row">
          <label className="field-label">Name<input className="field" value={createName} onChange={e => setCreateName(e.target.value)} placeholder="Full name" /></label>
          <label className="field-label">Email<input className="field" type="email" value={createEmail} onChange={e => setCreateEmail(e.target.value)} placeholder="email@example.com" /></label>
        </div>

        {createRole === 'teacher' && (
          <>
            <label className="field-label checkbox-row">
              <input type="checkbox" checked={createIsCoordinator} onChange={e => setCreateIsCoordinator(e.target.checked)} />
              Mark as branch coordinator
            </label>
            <div className="editor-section">
              <p className="eyebrow">Assigned khat types</p>
              <div className="script-toggle-group">
                {khatTypesList.map(khatType => (
                  <button
                    type="button"
                    key={khatType.id}
                    className={`script-toggle-chip ${createKhatTypeIds.includes(khatType.id) ? 'active' : ''}`}
                    onClick={() => toggleCreateKhatType(khatType.id)}
                  >
                    {khatType.display_name}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="modal-actions">
          <Button onClick={createAccount}>Create account</Button>
        </div>
        {createdAccount && (
          <div className="info-banner"><Check size={16} /><span>Temporary password for {createdAccount.email}: <strong>{createdAccount.tempPassword}</strong></span></div>
        )}
      </div>
      <div className="stats-grid">
        <StatCard icon={Users} value={String(activeCount)} label="Active teachers" />
        <StatCard icon={ClipboardList} value={`${avgCapacity}%`} label="Avg. capacity used" />
        <StatCard icon={Award} value={String(overflow.length)} label="Overflow entries" />
      </div>
      <div className="info-banner"><Check size={16} /><span>Teachers only receive entries matching their assigned khat type(s). Admin manual override can assign any entry to any teacher — this is logged and unrestricted.</span></div>
      <div className="teacher-branch-filter">
        <label className="field-label" htmlFor="teacher-branch-filter">View teachers by branch</label>
        <select id="teacher-branch-filter" className="field" value={teacherBranchFilter} onChange={event => setTeacherBranchFilter(event.target.value)}>
          <option value="all">All branches</option>
          {branchList.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
        <span>{filteredStaff.length} teacher{filteredStaff.length === 1 ? '' : 's'}</span>
      </div>
      <div className="teacher-table staff-table">
        <div className="table-head"><span>Teacher</span><span>Branch</span><span>Assigned khat types</span><span>Current load</span><span>Threshold</span><span>Action</span></div>
        {filteredStaff.map((t) => (
          <div className="history-row" key={t.id}>
            <span><strong>{t.name}</strong>{t.is_coordinator && <StatusChip tone="blue">Coord</StatusChip>}</span>
            <span>{branchMap[t.branch_id] ?? '—'}</span>
            <span>
              <div className="script-toggle-group">
                {scriptList.map(s => (
                  <button
                    key={s}
                    className={`script-toggle-chip ${(assignedScripts[t.id] ?? []).includes(s) ? 'active' : ''}`}
                    style={{ '--script': khatTypes[s].color } as React.CSSProperties}
                    onClick={() => toggleScript(t.id, s)}
                  >
                    {khatTypes[s].name}
                  </button>
                ))}
              </div>
            </span>
            <span className="teacher-load-cell"><div className="tiny-progress"><i style={{ width: `${Math.min(100, (loadFor(t.id) / Math.max(1, t.entry_load_threshold)) * 100)}%` }} /></div><small>{loadFor(t.id)}/{t.entry_load_threshold} entries</small></span>
            <span><input className="inline-input" value={thresholdDrafts[t.id] ?? ''} onChange={e => setThresholdDrafts(prev => ({ ...prev, [t.id]: e.target.value }))} /></span>
            <Button outline onClick={() => saveThreshold(t.id)}>Save</Button>
          </div>
        ))}
        {!loading && filteredStaff.length === 0 && <p className="muted teacher-filter-empty">No teachers are assigned to this branch.</p>}
      </div>
      <SectionHeading title="Administrator accounts" text="Assign the branch context used by event hosting and branch-aware operations." />
      <div className="teacher-table admin-staff-table">
        <div className="table-head"><span>Administrator</span><span>Email</span><span>Branch context</span><span>Action</span></div>
        {adminStaff.length === 0 && <p className="muted">No additional administrator accounts.</p>}
        {adminStaff.map(admin => (
          <div className="history-row" key={admin.id}>
            <span><strong>{admin.name}</strong></span>
            <span>{admin.email}</span>
            <span><select className="field compact" value={adminBranchDrafts[admin.id] ?? admin.branch_id} onChange={e => setAdminBranchDrafts(prev => ({ ...prev, [admin.id]: e.target.value }))}>{branchList.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></span>
            <Button outline onClick={() => saveAdminBranch(admin.id)}>Save branch</Button>
          </div>
        ))}
      </div>
      <SectionHeading title="Overflow / pending queue" text="Entries with no available teacher under threshold. Admin can manually assign to any teacher — even at or above threshold, and regardless of khat-type assignment." action={<Button outline onClick={() => setShowOverflow(!showOverflow)}>{showOverflow ? 'Hide' : 'Show'} overflow</Button>} />
      {showOverflow && (
        <div className="teacher-table overflow-table">
          <div className="table-head"><span>Entry ID</span><span>Student</span><span>Script</span><span>Branch</span><span>Assign to</span></div>
          {overflow.length === 0 && <p className="muted">Nothing in the overflow queue.</p>}
          {overflow.map((e) => {
            const kt = khatTypesList.find(k => k.id === e.khat_type_id);
            return (
              <div className="history-row" key={e.id}>
                <span>{e.id.slice(0, 8)}</span>
                <span>{e.student_name}</span>
                <span>{kt?.display_name ?? '—'}</span>
                <span>{branchMap[e.student_branch_id] ?? '—'}</span>
                <span>
                  <select className="field compact" value={assignDrafts[e.id] ?? ''} onChange={ev => setAssignDrafts(prev => ({ ...prev, [e.id]: ev.target.value }))}>
                    <option value="">Select teacher</option>
                    {staff.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <Button onClick={() => assignOverflow(e.id)}>Assign</Button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type ApiLogRow = {
  id: string; entry_id: string; action: string; actor_name: string | null; notes: string | null; created_at: string;
  student_name: string; student_branch_id: string; khat_type_id: string | null;
};

function EntryLogs() {
  const [logs, setLogs] = useState<ApiLogRow[]>([]);
  const [branchList, setBranchList] = useState<ApiBranch[]>([]);
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [branchFilter, setBranchFilter] = useState('');
  const [khatTypeFilter, setKhatTypeFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (branchFilter) params.set('branchId', branchFilter);
      if (khatTypeFilter) params.set('khatTypeId', khatTypeFilter);
      if (actionFilter) params.set('action', actionFilter);
      const [logsList, branches_, khatList] = await Promise.all([
        apiFetch<ApiLogRow[]>(`/entries/logs?${params.toString()}`),
        branchList.length ? Promise.resolve(branchList) : apiFetch<ApiBranch[]>('/branches'),
        khatTypesList.length ? Promise.resolve(khatTypesList) : apiFetch<ApiKhatType[]>('/khat-types'),
      ]);
      setLogs(logsList);
      setBranchList(branches_);
      setKhatTypesList(khatList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load entry logs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [branchFilter, khatTypeFilter, actionFilter]);

  const filtered = search
    ? logs.filter(l => l.student_name.toLowerCase().includes(search.toLowerCase()) || (l.notes ?? '').toLowerCase().includes(search.toLowerCase()))
    : logs;

  return (
    <div className="entry-logs-page">
      <SectionHeading eyebrow="Accountability" title="Entry Logs" text="A complete record of assignment, review, and diversion decisions." action={<div className="search-field"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search entries" /></div>} />
      {error && <p className="error-text">{error}</p>}
      <div className="filter-bar admin-filters">
        <span>Filters</span>
        <select className="field compact" value={branchFilter} onChange={e => setBranchFilter(e.target.value)}>
          <option value="">All branches</option>
          {branchList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select className="field compact" value={khatTypeFilter} onChange={e => setKhatTypeFilter(e.target.value)}>
          <option value="">All scripts</option>
          {khatTypesList.map(k => <option key={k.id} value={k.id}>{k.display_name}</option>)}
        </select>
        <select className="field compact" value={actionFilter} onChange={e => setActionFilter(e.target.value)}>
          <option value="">All actions</option>
          <option value="assigned">Assigned</option>
          <option value="auto_diverted">Auto-diverted</option>
          <option value="manual_diverted">Manually diverted</option>
          <option value="locked">Locked</option>
          <option value="reviewed">Reviewed</option>
          <option value="idle_flagged">Idle-flagged</option>
        </select>
      </div>
      <div className="history-table admin-table entry-logs-table">
        <div className="table-head"><span>Entry ID</span><span>Student</span><span>Action</span><span>Actor</span><span>Timestamp</span><span>Notes</span></div>
        {filtered.length === 0 && !loading && <div className="entry-logs-empty"><span><ClipboardList size={19} /></span><strong>No logs found</strong><p>No entries match these filters. Try widening the filters or changing your search.</p></div>}
        {filtered.map(row => (
          <div className="history-row" key={row.id}>
            <span data-label="Entry ID">{row.entry_id.slice(0, 8)}</span>
            <span data-label="Student">{row.student_name}</span>
            <span data-label="Action">{row.action.replace(/_/g, ' ')}</span>
            <span data-label="Actor">{row.actor_name ?? 'System'}</span>
            <span data-label="Timestamp">{new Date(row.created_at).toLocaleString()}</span>
            <span data-label="Notes">{row.notes || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type ApiShowcaseAdminRow = { id: string; user_role: string; author_name: string; caption: string | null; status: string; image_storage_key?: string; imageUrl?: string };

function ShowcaseModeration() {
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const [pending, setPending] = useState<ApiShowcaseAdminRow[]>([]);
  const [all, setAll] = useState<ApiShowcaseAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const posts = tab === 'pending'
        ? await apiFetch<ApiShowcaseAdminRow[]>('/showcase/pending')
        : await apiFetch<ApiShowcaseAdminRow[]>('/showcase?status=all');
      const withImages = await Promise.all(posts.map(async post => ({
        ...post,
        imageUrl: post.image_storage_key ? await getViewUrl(post.image_storage_key).catch(() => undefined) : undefined,
      })));
      if (tab === 'pending') setPending(withImages);
      else setAll(withImages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load showcase posts.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);

  const moderate = async (id: string, decision: 'approve' | 'reject') => {
    try {
      await apiFetch(`/showcase/${id}/moderate`, { method: 'POST', body: { decision } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to moderate this post.');
    }
  };

  const removePost = async (id: string) => {
    if (!window.confirm('Remove this showcase post permanently?')) return;
    try {
      await apiFetch(`/showcase/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove this post.');
    }
  };

  return (
    <div className="showcase-moderation-page">
      <SectionHeading eyebrow="Trust & care" title="Showcase Moderation" text="Review student work before it becomes part of the public gallery. Teacher posts bypass moderation but can be removed." />
      {error && <p className="error-text">{error}</p>}
      <div className="tabs small">
        <button className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>Pending student submissions</button>
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>All posts (students + teachers)</button>
      </div>
      {tab === 'pending' ? (
        <div className="moderation-grid">
          {pending.length === 0 && !loading && <div className="showcase-moderation-empty"><span><Sparkles size={19} /></span><div><strong>All caught up</strong><p>There are no student submissions waiting for review. New work will appear here when it is submitted.</p></div></div>}
          {pending.map(work => (
            <div className="moderation-card" key={work.id}>
              <div className="row-art large">{work.imageUrl ? <img className="moderation-work-image" src={work.imageUrl} alt={`Artwork by ${work.author_name}`} /> : <FileImage size={22} />}</div>
              <div className="moderation-copy"><strong>{work.author_name}</strong><span>{work.caption || 'Student artwork awaiting review.'}</span></div>
              <div><Button onClick={() => moderate(work.id, 'approve')}>Approve</Button><Button outline onClick={() => moderate(work.id, 'reject')}>Reject</Button></div>
            </div>
          ))}
        </div>
      ) : (
        <div className="teacher-table showcase-all-table">
          <div className="table-head"><span>Post</span><span>Author</span><span>Role</span><span>Status</span><span>Action</span></div>
          {all.length === 0 && !loading && <div className="showcase-moderation-empty"><span><Images size={19} /></span><div><strong>No showcase posts yet</strong><p>Student and teacher posts will appear here for moderation and review.</p></div></div>}
          {all.map(work => (
            <div className="history-row" key={work.id}>
              <span data-label="Post"><div className="row-art small">{work.imageUrl ? <img className="moderation-work-image" src={work.imageUrl} alt={`Artwork by ${work.author_name}`} /> : <FileImage size={16} />}</div></span>
              <span data-label="Author">{work.author_name}</span>
              <span data-label="Role">{work.user_role === 'teacher' ? <StatusChip tone="blue">Teacher</StatusChip> : <StatusChip>Student</StatusChip>}</span>
              <span data-label="Status"><StatusChip tone={work.status === 'approved' ? 'green' : work.status === 'pending' ? 'amber' : 'red'}>{work.status}</StatusChip></span>
              <span data-label="Action"><Button outline onClick={() => void removePost(work.id)}><Trash2 size={14} /> Remove</Button></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type ApiCompetitionAdmin = { id: string; title: string; khat_type_id: string | null; judging_deadline: string | null; judge_teacher_id: string | null; status: string; results_published_at: string | null };

function CompetitionsManager() {
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [staff, setStaff] = useState<ApiStaffRow[]>([]);
  const [list, setList] = useState<ApiCompetitionAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [khatTypeId, setKhatTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [judgingDeadline, setJudgingDeadline] = useState('');
  const [judgeDrafts, setJudgeDrafts] = useState<Record<string, string>>({});
  const [editingJudgeFor, setEditingJudgeFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [khatList, staffList, comps] = await Promise.all([
        apiFetch<ApiKhatType[]>('/khat-types'),
        apiFetch<ApiStaffRow[]>('/admin/users?role=teacher'),
        apiFetch<ApiCompetitionAdmin[]>('/competitions'),
      ]);
      setKhatTypesList(khatList);
      setStaff(staffList);
      setList(comps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load competitions.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!title || !startDate || !endDate) { setError('Title, start date, and end date are required.'); return; }
    try {
      await apiFetch('/competitions', { method: 'POST', body: { title, description, khatTypeId: khatTypeId || undefined, startDate, endDate, judgingDeadline: judgingDeadline || undefined } });
      setTitle(''); setDescription(''); setKhatTypeId(''); setStartDate(''); setEndDate(''); setJudgingDeadline('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create competition.');
    }
  };

  const assignJudge = async (competitionId: string) => {
    const teacherId = judgeDrafts[competitionId];
    if (!teacherId) return;
    try {
      await apiFetch(`/competitions/${competitionId}/assign-judge`, { method: 'POST', body: { teacherId } });
      setEditingJudgeFor(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign judge.');
    }
  };

  const publishResults = async (competitionId: string) => {
    try {
      await apiFetch(`/competitions/${competitionId}/publish-results`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to publish — has the judge submitted winners yet?');
    }
  };

  return (
    <div className="competitions-manager-page">
      <SectionHeading eyebrow="Guild challenges" title="Competitions Manager" text="Create, assign judges, and post results." />
      {error && <p className="error-text">{error}</p>}
      <div className="admin-form-card competition-create-card">
        <h3>Create competition</h3>
        <label className="field-label">Title<input className="field" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. The patient line" /></label>
        <label className="field-label">Description<textarea className="field textarea" value={description} onChange={e => setDescription(e.target.value)} placeholder="What should students write?" /></label>
        <div className="competition-form-grid">
          <label className="field-label">Khat type<select className="field" value={khatTypeId} onChange={e => setKhatTypeId(e.target.value)}><option value="">Any script</option>{khatTypesList.map(k => <option key={k.id} value={k.id}>{k.display_name}</option>)}</select></label>
          <label className="field-label">Start date<input className="field" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
          <label className="field-label">End date<input className="field" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></label>
          <label className="field-label">Judging deadline<input className="field" type="date" value={judgingDeadline} onChange={e => setJudgingDeadline(e.target.value)} /></label>
        </div>
        <Button onClick={create}>Create competition <ArrowRight size={15} /></Button>
      </div>
      <SectionHeading title="All competitions" text="Assign a judge and publish results once judging is complete." />
      <div className="teacher-table competition-list">
        <div className="table-head"><span>Title</span><span>Script</span><span>Deadline</span><span>Judge</span><span>Action</span></div>
        {!loading && list.length === 0 && <div className="competition-list-empty"><span><Trophy size={19} /></span><div><strong>No competitions yet</strong><p>Create a competition above. It will appear here when saved.</p></div></div>}
        {list.map(c => {
          const kt = khatTypesList.find(k => k.id === c.khat_type_id);
          const showJudgeSelect = editingJudgeFor === c.id || !c.judge_teacher_id;
          return (
            <div className="history-row" key={c.id}>
              <span data-label="Competition"><strong>{c.title}</strong><StatusChip tone={c.status === 'completed' ? 'green' : 'amber'}>{c.status}</StatusChip></span>
              <span data-label="Script">{kt?.display_name ?? 'Any'}</span>
              <span data-label="Judging deadline">{c.judging_deadline ? new Date(c.judging_deadline).toLocaleDateString() : '—'}</span>
              <span data-label="Judge">
                {showJudgeSelect ? (
                  <>
                    <select className="field compact" value={judgeDrafts[c.id] ?? c.judge_teacher_id ?? ''} onChange={e => setJudgeDrafts(prev => ({ ...prev, [c.id]: e.target.value }))}>
                      <option value="">Select a teacher</option>
                      {staff.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <Button onClick={() => assignJudge(c.id)}>Assign</Button>
                  </>
                ) : (
                  <>
                    {staff.find(t => t.id === c.judge_teacher_id)?.name ?? 'Assigned'}
                    <button className="text-link" onClick={() => setEditingJudgeFor(c.id)}>Change</button>
                  </>
                )}
              </span>
              <span data-label="Action">{c.status === 'completed' && !c.results_published_at ? (
                <Button outline onClick={() => publishResults(c.id)}>Post results</Button>
              ) : c.results_published_at ? (
                <StatusChip tone="green">Published</StatusChip>
              ) : (
                <span className="muted">Awaiting judge</span>
              )}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ApiEventAdmin = { id: string; title: string; scheduled_at: string; status: string; host_name: string; branch_name: string; recording_storage_key: string | null; recording_status?: 'processing' | 'ready' | null };

function EventsManager() {
  const [events, setEvents] = useState<ApiEventAdmin[]>([]);
  const [detailFor, setDetailFor] = useState<ApiEventAdmin | null>(null);
  const [attendance, setAttendance] = useState<{ live_attendance_count: string; recording_watch_count: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => apiFetch<ApiEventAdmin[]>('/events').then(setEvents).catch(err => setError(err instanceof ApiError ? err.message : 'Failed to load events.'));
  useEffect(() => { load(); }, []);

  const openDetails = async (ev: ApiEventAdmin) => {
    setDetailFor(ev);
    setAttendance(await apiFetch<{ live_attendance_count: string; recording_watch_count: string }>(`/events/${ev.id}/attendance`).catch(() => null));
  };

  const removeEvent = async (id: string) => {
    if (!window.confirm('Delete this event? This will remove its event record and attendance history.')) return;
    try {
      await apiFetch(`/events/${id}`, { method: 'DELETE' });
      setDetailFor(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete this event.');
    }
  };
  const removeRecording = async (id: string) => {
    if (!window.confirm('Remove the recording from this event?')) return;
    try {
      await apiFetch(`/events/${id}/remove-recording`, { method: 'PATCH' });
      setDetailFor(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove this recording.');
    }
  };

  return (
    <>
      <SectionHeading eyebrow="Across the guild" title="Live Events Manager" text="See every circle, clinic, and recording across the branches." />
      {error && <p className="error-text">{error}</p>}
      <div className="stats-grid">
        <StatCard icon={CalendarDays} value={String(events.length)} label="Total events" />
        <StatCard icon={Play} value={String(events.filter(e => e.recording_storage_key).length)} label="Recordings published" />
        <StatCard icon={Users} value={String(events.filter(e => e.status === 'live').length)} label="Live now" />
      </div>
      <div className="event-list">
        {events.length === 0 && <p className="muted">No events yet.</p>}
        {events.map((ev) => (
          <div className="event-row" key={ev.id}>
            <div className="event-date"><span>{new Date(ev.scheduled_at).getDate()}</span><small>{new Date(ev.scheduled_at).toLocaleString('en', { month: 'short' }).toUpperCase()}</small></div>
            <div><strong>{ev.title}</strong><span>{ev.host_name} · {ev.branch_name}</span></div>
            <StatusChip tone={ev.status === 'live' ? 'green' : ev.status === 'ended' ? 'gold' : 'blue'}>{ev.status}</StatusChip>
            <Button outline onClick={() => openDetails(ev)}>View details</Button>
          </div>
        ))}
      </div>
      {detailFor && (
        <Modal onClose={() => setDetailFor(null)}>
          <p className="eyebrow">{detailFor.title}</p>
          <h2>{detailFor.host_name} · {detailFor.branch_name}</h2>
          {attendance && <p>{attendance.live_attendance_count} joined live · {attendance.recording_watch_count} watched the recording</p>}
          <div className="modal-actions">
            {detailFor.recording_storage_key && <Button outline onClick={() => removeRecording(detailFor.id)}>Remove recording</Button>}
            <Button outline onClick={() => removeEvent(detailFor.id)}>Delete event</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

type ApiBookAdmin = { id: string; title: string; khat_type_id: string | null };

function ResourceManager() {
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [booksList, setBooksList] = useState<ApiBookAdmin[]>([]);
  const [title, setTitle] = useState('');
  const [khatTypeId, setKhatTypeId] = useState('');
  const [khatTypeMenuOpen, setKhatTypeMenuOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [khatList, books_] = await Promise.all([apiFetch<ApiKhatType[]>('/khat-types'), apiFetch<ApiBookAdmin[]>('/books')]);
      setKhatTypesList(khatList);
      setBooksList(books_);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load resources.');
    }
  };
  useEffect(() => { load(); }, []);

  const upload = async () => {
    if (!title || !file) { setError('Title and a file are required.'); return; }
    try {
      const { storageKey, originalFilename } = await uploadFile('books', file);
      await apiFetch('/books', { method: 'POST', body: { title, khatTypeId: khatTypeId || undefined, fileStorageKey: storageKey, originalFilename } });
      setTitle(''); setKhatTypeId(''); setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to upload book.');
    }
  };

  const remove = async (id: string) => {
    const book = booksList.find(item => item.id === id);
    if (!window.confirm(`Delete “${book?.title ?? 'this resource'}” from the library?`)) return;
    try {
      await apiFetch(`/books/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete this resource.');
    }
  };

  return (
    <div className="resource-manager-page">
      <SectionHeading eyebrow="The library" title="Resource Library Manager" text="Upload and manage downloadable books. Tag by khat type." />
      {error && <p className="error-text">{error}</p>}
      <div className="admin-form-card resource-upload-card">
        <h3>Upload book</h3>
        <label className="field-label">Title<input className="field" value={title} onChange={e => setTitle(e.target.value)} placeholder="Book title" /></label>
        <div className="resource-upload-grid">
          <label className="field-label">Khat type
            <span className={`auth-role-picker resource-type-picker${khatTypeMenuOpen ? ' open' : ''}`}>
              <button type="button" className="auth-role-trigger" aria-haspopup="listbox" aria-expanded={khatTypeMenuOpen} onClick={() => setKhatTypeMenuOpen(value => !value)}>
                <span>{khatTypesList.find(k => k.id === khatTypeId)?.display_name ?? 'General'}</span><ChevronDown size={15} />
              </button>
              {khatTypeMenuOpen && <span className="auth-role-menu" role="listbox" aria-label="Choose khat type">
                <button type="button" role="option" aria-selected={!khatTypeId} className={!khatTypeId ? 'selected' : ''} onClick={() => { setKhatTypeId(''); setKhatTypeMenuOpen(false); }}>General</button>
                {khatTypesList.map(k => <button type="button" role="option" aria-selected={khatTypeId === k.id} className={khatTypeId === k.id ? 'selected' : ''} key={k.id} onClick={() => { setKhatTypeId(k.id); setKhatTypeMenuOpen(false); }}>{k.display_name}</button>)}
              </span>}
            </span>
          </label>
          <div className="resource-upload-field"><span className="resource-upload-label">File</span><UploadBox label={file?.name ?? 'Choose a file'} sublabel="Drag and drop a PDF or image, or browse" accept="application/pdf,image/*" onChange={setFile} /></div>
        </div>
        <Button onClick={upload}>Upload book <Upload size={15} /></Button>
      </div>
      <div className="teacher-table resource-book-table">
        <div className="table-head"><span>Title</span><span>Khat type</span><span>Action</span></div>
        {booksList.length === 0 && <div className="resource-library-empty"><span><BookOpen size={19} /></span><div><strong>The library is ready for its first resource</strong><p>Upload a book above to make it available to students and teachers.</p></div></div>}
        {booksList.map(b => {
          const kt = khatTypesList.find(k => k.id === b.khat_type_id);
          return (
            <div className="history-row" key={b.id}>
              <span data-label="Title"><strong>{b.title}</strong></span>
              <span data-label="Khat type">{kt?.display_name ?? 'General'}</span>
              <span data-label="Action"><button className="text-link danger" onClick={() => remove(b.id)}><Trash2 size={14} /> Delete</button></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ApiAdminStatistics = {
  summary: {
    students: number; teachers: number; admins: number; total_users: number; active_users_30d: number;
    total_logins: number; logins_today: number; entries_submitted: number; entries_reviewed: number;
    entries_pending: number; entries_assigned: number; entries_in_review: number; entries_needing_redo: number;
    certificates_approved: number; certificates_pending: number; showcase_approved: number; showcase_pending: number;
    competitions_total: number; competitions_active: number; competition_entries: number; events_total: number;
    events_live: number; live_attendance: number; recording_views: number; books_total: number;
    courses_total: number; practice_submissions: number;
  };
  activityTrend: { month: string; logins: number; active_users: number; submitted: number; reviewed: number }[];
  branchEnrollment: { id: string; name: string; students: number }[];
  entryStatuses: { status: string; count: number }[];
  teacherThroughput: { id: string; name: string; reviewed: number }[];
  competitionParticipation: { id: string; title: string; entries: number }[];
};

function StatisticsDashboard() {
  const [data, setData] = useState<ApiAdminStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiFetch<ApiAdminStatistics>('/admin/statistics'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load site statistics.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const summary = data?.summary;
  const trendMax = Math.max(1, ...(data?.activityTrend ?? []).flatMap(m => [m.logins, m.active_users]));
  const branchMax = Math.max(1, ...(data?.branchEnrollment ?? []).map(b => b.students));
  const teacherMax = Math.max(1, ...(data?.teacherThroughput ?? []).map(t => t.reviewed));
  const competitionMax = Math.max(1, ...(data?.competitionParticipation ?? []).map(c => c.entries));

  return (
    <div className="admin-statistics-page">
      <SectionHeading eyebrow="Org-wide analytics" title="Statistics Dashboard" text="A live view of account activity, learning, reviews, and participation across the guild." action={<Button outline onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh data'}</Button>} />
      {error && <div className="admin-error-banner" role="alert"><span>{error}</span><Button outline onClick={load}>Try again</Button></div>}
      {loading && !data && <p className="muted">Loading site statistics…</p>}
      {summary && (
        <>
          <div className="stats-grid admin-stat-grid admin-stat-grid-expanded">
            <StatCard icon={Users} value={String(summary.students)} label="Students" />
            <StatCard icon={BookOpen} value={String(summary.teachers)} label="Teachers" />
            <StatCard icon={Activity} value={String(summary.active_users_30d)} label="Active users · 30 days" />
            <StatCard icon={Activity} value={String(summary.logins_today)} label="Logins today" />
            <StatCard icon={ClipboardList} value={String(summary.entries_submitted)} label="Entries submitted" />
            <StatCard icon={Check} value={String(summary.entries_reviewed)} label="Entries reviewed" />
            <StatCard icon={Award} value={String(summary.certificates_approved)} label="Certificates approved" />
            <StatCard icon={CalendarDays} value={String(summary.live_attendance)} label="Live attendances" />
          </div>

          <div className="admin-dashboard-grid">
            <section className="chart-card admin-chart-card">
              <SectionHeading eyebrow="Engagement" title="Logins & learning activity" text={`12 months · ${summary.total_logins.toLocaleString()} recorded logins overall`} />
              <div className="admin-chart-legend"><span><i /> Logins</span><span><i className="secondary" /> Active users</span></div>
              <div className="admin-month-chart">
                {data.activityTrend.map((month, index) => (
                  <div className="admin-month-column" key={month.month} style={{ animationDelay: `${index * 35}ms` }} title={`${month.month}: ${month.logins} logins, ${month.active_users} active users`}>
                    <div className="admin-month-bars">
                      <i className="login-bar" style={{ height: `${Math.max(3, month.logins / trendMax * 100)}%` }} />
                      <i className="active-bar" style={{ height: `${Math.max(3, month.active_users / trendMax * 100)}%` }} />
                    </div>
                    <small>{new Date(`${month.month}-01T12:00:00`).toLocaleString(undefined, { month: 'short' })}</small>
                  </div>
                ))}
              </div>
              <div className="admin-trend-summary">
                <span>{summary.entries_pending + summary.entries_assigned + summary.entries_in_review} open entries</span>
                <span>{summary.practice_submissions.toLocaleString()} practice uploads</span>
              </div>
            </section>

            <section className="chart-card admin-chart-card">
              <SectionHeading eyebrow="Learning" title="Entry pipeline" text="Current entry counts by review status" />
              <div className="admin-horizontal-bars">
                {data.entryStatuses.map(row => (
                  <div className="admin-horizontal-bar" key={row.status}>
                    <span>{row.status.replace(/_/g, ' ')}</span>
                    <div><i style={{ width: `${row.count ? Math.max(2, row.count / Math.max(1, ...data.entryStatuses.map(s => s.count)) * 100) : 0}%` }} /></div>
                    <strong>{row.count}</strong>
                  </div>
                ))}
                {data.entryStatuses.length === 0 && <p className="muted">No entries have been submitted yet.</p>}
              </div>
              <p className="admin-chart-note">{summary.entries_needing_redo} entries are awaiting student redo.</p>
            </section>
          </div>

          <div className="admin-dashboard-grid">
            <section className="chart-card admin-chart-card">
              <SectionHeading eyebrow="Branches" title="Student enrollment" />
              <div className="admin-horizontal-bars">
                {data.branchEnrollment.map(branch => <div className="admin-horizontal-bar" key={branch.id}><span>{branch.name}</span><div><i style={{ width: `${branch.students ? Math.max(2, branch.students / branchMax * 100) : 0}%` }} /></div><strong>{branch.students}</strong></div>)}
                {data.branchEnrollment.length === 0 && <p className="muted">No branches found.</p>}
              </div>
            </section>
            <section className="chart-card admin-chart-card">
              <SectionHeading eyebrow="Teaching" title="Teacher review throughput" text="Reviewed entries per teacher" />
              <div className="admin-horizontal-bars">
                {data.teacherThroughput.map(teacher => <div className="admin-horizontal-bar" key={teacher.id}><span>{teacher.name}</span><div><i style={{ width: `${teacher.reviewed ? Math.max(2, teacher.reviewed / teacherMax * 100) : 0}%` }} /></div><strong>{teacher.reviewed}</strong></div>)}
                {data.teacherThroughput.length === 0 && <p className="muted">No active teachers found.</p>}
              </div>
            </section>
          </div>

          <div className="admin-dashboard-grid">
            <section className="chart-card admin-chart-card">
              <SectionHeading eyebrow="Guild challenges" title="Competition participation" text={`${summary.competition_entries} entries across all competitions`} />
              <div className="admin-horizontal-bars">
                {data.competitionParticipation.map(comp => <div className="admin-horizontal-bar" key={comp.id}><span>{comp.title}</span><div><i style={{ width: `${comp.entries ? Math.max(2, comp.entries / competitionMax * 100) : 0}%` }} /></div><strong>{comp.entries}</strong></div>)}
                {data.competitionParticipation.length === 0 && <div className="admin-chart-empty"><span><Trophy size={15} /></span><div><strong>No competitions yet</strong><p>Participation will appear here once a competition has entries.</p></div></div>}
              </div>
            </section>
            <section className="chart-card admin-chart-card">
              <SectionHeading eyebrow="Whole-site activity" title="Content & community" />
              <div className="admin-activity-grid">
                <div><strong>{summary.admins}</strong><span>Admins</span></div>
                <div><strong>{summary.certificates_pending}</strong><span>Certificates pending</span></div>
                <div><strong>{summary.showcase_approved}</strong><span>Showcase posts</span></div>
                <div><strong>{summary.showcase_pending}</strong><span>Posts to moderate</span></div>
                <div><strong>{summary.competitions_active}</strong><span>Active competitions</span></div>
                <div><strong>{summary.events_live}/{summary.events_total}</strong><span>Live / total events</span></div>
                <div><strong>{summary.recording_views}</strong><span>Recording views</span></div>
                <div><strong>{summary.books_total}</strong><span>Library resources</span></div>
                <div><strong>{summary.courses_total}</strong><span>Courses</span></div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

type ApiPendingCert = { id: string; title: string; student_name: string; issued_at: string };
type ApiGovernanceRow = { id: string; name: string; role: 'student' | 'teacher'; branch_id: string; tr_number?: string | null; is_coordinator?: boolean; photo_storage_key?: string | null };
type GovernanceProfileView = { role: 'student' | 'teacher'; profile: Record<string, unknown>; photoUrl: string | null; branchName: string };

function GovernanceAvatar({ name, storageKey, className = 'governance-person-avatar' }: { name: string; storageKey?: string | null; className?: string }) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const avatarRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!storageKey || !avatarRef.current) return;
    let cancelled = false;
    const loadUrl = () => {
      void getViewUrl(storageKey).then(url => {
        if (!cancelled) setPhotoUrl(url);
      }).catch(() => {});
    };

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer.disconnect();
          loadUrl();
        }
      }, { rootMargin: '140px' });
      observer.observe(avatarRef.current);
      return () => { cancelled = true; observer.disconnect(); };
    }

    loadUrl();
    return () => { cancelled = true; };
  }, [storageKey]);

  return <span className={className} ref={avatarRef}>{photoUrl ? <img src={photoUrl} alt={`${name} profile`} loading="lazy" /> : name.trim().slice(0, 1).toUpperCase()}</span>;
}

function governanceFieldLabel(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function governanceFieldValue(key: string, value: unknown, khatTypesList: ApiKhatType[]): string {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'khat_type_id') return khatTypesList.find(khatType => khatType.id === value)?.display_name ?? String(value);
  if (key.endsWith('_storage_key')) return value ? 'File attached' : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : String(value);
  if (typeof value === 'string') {
    if (/(_at|_date|At|Date)$/.test(key) && !Number.isNaN(Date.parse(value))) return new Date(value).toLocaleString();
    return value;
  }
  if (Array.isArray(value)) return `${value.length} records`;
  return JSON.stringify(value);
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildProfilePdf(title: string, lines: Array<[string, string]>): Blob {
  const contentLines = lines.map(([label, value], index) => {
    const y = 720 - (index * 26);
    return [
      `BT /F1 10 Tf 50 ${y} Td (${escapePdfText(label)}) Tj ET`,
      `BT /F1 11 Tf 150 ${y} Td (${escapePdfText(value)} ) Tj ET`,
    ].join('\n');
  }).join('\n');

  const pdfChunks: string[] = ['%PDF-1.4\n'];
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const stream = `BT\n/F1 18 Tf\n50 760 Td\n(${escapePdfText(title)}) Tj\nET\n${contentLines}`;
  const streamLength = new TextEncoder().encode(stream).length;
  objects.push(`<< /Length ${streamLength} >>\nstream\n${stream}\nendstream`);

  for (let i = 0; i < objects.length; i++) {
    const offset = pdfChunks.join('').length;
    pdfChunks.push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
    // keep a placeholder to compute xref offsets after object generation
    if (i === 0) {
      pdfChunks[0] += '';
    }
  }

  const xrefOffset = pdfChunks.join('').length;
  pdfChunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);

  let runningOffset = 0;
  for (let i = 0; i < objects.length; i++) {
    const offsetString = `${String(runningOffset).padStart(10, '0')}`;
    pdfChunks.push(`${offsetString} 00000 n \n`);
    runningOffset += 0;
  }

  const finalPdf = (() => {
    const full = pdfChunks.join('');
    const actualOffsets: number[] = [0];
    let cursor = 0;
    const generator = '%PDF-1.4\n';
    const bodyParts: string[] = [];
    for (let i = 0; i < objects.length; i++) {
      actualOffsets.push(generator.length + cursor);
      bodyParts.push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
      cursor += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`.length;
    }

    const xrefStart = generator.length + cursor;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 0; i < objects.length; i++) {
      const offset = actualOffsets[i + 1];
      xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    return `${generator}${bodyParts.join('')}${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  })();

  return new Blob([finalPdf], { type: 'application/pdf' });
}

function GovernanceManager({ section }: { section: 'certificates' | 'governance' }) {
  const [templates, setTemplates] = useState<ApiCertTemplate[]>([]);
  const [pendingCerts, setPendingCerts] = useState<ApiPendingCert[]>([]);
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [awardCategory, setAwardCategory] = useState<'certification' | 'secondary'>('certification');
  const [awardCourses, setAwardCourses] = useState<ApiCourse[]>([]);
  const [awardLevels, setAwardLevels] = useState<ApiLevel[]>([]);
  const [awardKhatTypeId, setAwardKhatTypeId] = useState('');
  const [badgeKhatTypeId, setBadgeKhatTypeId] = useState('');
  const [awardCourseId, setAwardCourseId] = useState('');
  const [awardLevelId, setAwardLevelId] = useState('');
  const [templateTitle, setTemplateTitle] = useState('');
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [badgeAssets, setBadgeAssets] = useState<ApiBadgeAsset[]>([]);
  const [badgeTier, setBadgeTier] = useState<BadgeTier>('foundation');
  const [badgeFile, setBadgeFile] = useState<File | null>(null);
  const [savingBadgeAsset, setSavingBadgeAsset] = useState(false);
  const [branchMap, setBranchMap] = useState<Record<string, string>>({});
  const [governanceRows, setGovernanceRows] = useState<ApiGovernanceRow[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; role: 'student' | 'teacher'; name: string } | null>(null);
  const [viewTarget, setViewTarget] = useState<GovernanceProfileView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      if (section === 'certificates') {
        const [templateList, pending, khatList, settings] = await Promise.all([
          apiFetch<ApiCertTemplate[]>('/certificates/templates'),
          apiFetch<ApiPendingCert[]>('/certificates/pending'),
          apiFetch<ApiKhatType[]>('/khat-types'),
          apiFetch<ApiSiteSetting[]>('/admin/settings'),
        ]);
        setTemplates(templateList);
        setPendingCerts(pending);
        setKhatTypesList(khatList);
        setAwardKhatTypeId(current => current || khatList[0]?.id || '');
        setBadgeKhatTypeId(current => current || khatList[0]?.id || '');
        const configured = settings.find(item => item.key === 'badge_assets')?.value;
        const assetRecords = configured && typeof configured === 'object' ? Object.entries(configured as Record<string, { storageKey?: string; filename?: string; mediaType?: 'image' | 'pdf' }> ) : [];
        const resolvedAssets = await Promise.all(assetRecords.flatMap(([key, asset]) => {
          if (!asset.storageKey || !asset.filename || (asset.mediaType !== 'image' && asset.mediaType !== 'pdf')) return [];
          return [getViewUrl(asset.storageKey).catch(() => null).then(url => ({ key, storageKey: asset.storageKey!, filename: asset.filename!, mediaType: asset.mediaType!, url }))];
        }));
        setBadgeAssets(resolvedAssets);
      } else {
        const [branchList, studentsList, staffList] = await Promise.all([
          apiFetch<ApiBranch[]>('/branches'),
          apiFetch<ApiGovernanceRow[]>('/students'),
          apiFetch<ApiStaffRow[]>('/admin/users'),
        ]);
        setBranchMap(Object.fromEntries(branchList.map(b => [b.id, b.name])));
        setGovernanceRows([
          ...studentsList.map(s => ({ ...s, role: 'student' as const })),
          ...staffList.filter(t => t.role === 'teacher').map(t => ({ id: t.id, name: t.name, role: 'teacher' as const, branch_id: t.branch_id, is_coordinator: t.is_coordinator, photo_storage_key: t.photo_storage_key })),
        ]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load governance data.');
    }
  };
  useEffect(() => { load(); }, [section]);

  useEffect(() => {
    if (section !== 'certificates' || !awardKhatTypeId) return;
    let cancelled = false;
    setAwardCourses([]);
    setAwardLevels([]);
    setAwardCourseId('');
    setAwardLevelId('');
    apiFetch<ApiCourse[]>(`/courses?khatTypeId=${awardKhatTypeId}&category=${awardCategory}`)
      .then(courses => {
        if (cancelled) return;
        setAwardCourses(courses);
        setAwardCourseId(courses[0]?.id ?? '');
      })
      .catch(err => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load courses for certificate setup.'); });
    return () => { cancelled = true; };
  }, [section, awardKhatTypeId, awardCategory]);

  useEffect(() => {
    if (section !== 'certificates' || awardCategory !== 'certification' || !awardCourseId) {
      setAwardLevels([]);
      setAwardLevelId('');
      return;
    }
    let cancelled = false;
    apiFetch<ApiLevel[]>(`/courses/${awardCourseId}/levels`)
      .then(levels => {
        if (cancelled) return;
        setAwardLevels(levels);
        setAwardLevelId(levels[0]?.id ?? '');
      })
      .catch(err => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load course levels.'); });
    return () => { cancelled = true; };
  }, [section, awardCategory, awardCourseId]);

  const approveCert = async (id: string) => {
    try { await apiFetch(`/certificates/${id}/approve`, { method: 'POST' }); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to approve this certificate.'); }
  };
  const rejectCert = async (id: string) => {
    try { await apiFetch(`/certificates/${id}/reject`, { method: 'POST' }); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to reject this certificate.'); }
  };
  const deleteTemplate = async (id: string) => {
    if (!window.confirm('Delete this certificate template? Existing issued certificates will remain unchanged.')) return;
    try { await apiFetch(`/certificates/templates/${id}`, { method: 'DELETE' }); await load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to delete this template.'); }
  };

  const viewTemplate = async (template: ApiCertTemplate) => {
    try {
      const url = await getViewUrl(template.file_storage_key);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to open this certificate file.');
    }
  };

  const createTemplate = async () => {
    if (!awardKhatTypeId || !templateTitle.trim() || !templateFile) {
      setError('Choose a khat, enter a certificate title, and upload a certificate file.');
      return;
    }
    if (awardCategory === 'certification' && !awardLevelId) {
      setError('Choose the primary course level that earns this certificate.');
      return;
    }
    if (awardCategory === 'secondary' && !awardCourseId) {
      setError('Choose the secondary course that earns this certificate on completion.');
      return;
    }
    setSavingTemplate(true);
    try {
      const { storageKey } = await uploadFile('certificates', templateFile);
      await apiFetch('/certificates/templates', {
        method: 'POST',
        body: {
          khatTypeId: awardKhatTypeId,
          title: templateTitle.trim(),
          fileStorageKey: storageKey,
          ...(awardCategory === 'certification' ? { levelId: awardLevelId } : { courseId: awardCourseId }),
        },
      });
      setTemplateTitle('');
      setTemplateFile(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create certificate template.');
    } finally {
      setSavingTemplate(false);
    }
  };

  const saveBadgeAsset = async () => {
    if (!badgeKhatTypeId || !badgeFile) {
      setError('Choose a Khat type and an image or PDF for this badge.');
      return;
    }
    setSavingBadgeAsset(true);
    setError(null);
    try {
      const { storageKey, originalFilename } = await uploadFile('badge-assets', badgeFile);
      const mediaType = badgeFile.type === 'application/pdf' || badgeFile.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image';
      await apiFetch(`/admin/settings/badges/${badgeKhatTypeId}/${badgeTier}`, {
        method: 'PUT',
        body: { storageKey, filename: originalFilename, mediaType },
      });
      setBadgeFile(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save badge artwork.');
    } finally {
      setSavingBadgeAsset(false);
    }
  };

  const removeBadgeAsset = async (khatTypeId: string, tier: BadgeTier) => {
    if (!window.confirm('Remove this badge artwork? Students will see the default mock badge instead.')) return;
    try {
      await apiFetch(`/admin/settings/badges/${khatTypeId}/${tier}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove badge artwork.');
    }
  };

  const viewRow = async (row: ApiGovernanceRow) => {
    try {
      const profile = await apiFetch<Record<string, unknown>>(row.role === 'student' ? `/students/${row.id}/profile` : `/teachers/${row.id}/profile`);
      const photoStorageKey = (profile.photoStorageKey as string | null | undefined) ?? row.photo_storage_key;
      const photoUrl = photoStorageKey ? await getViewUrl(photoStorageKey).catch(() => null) : null;
      const branchId = String(profile.branchId ?? row.branch_id);
      setViewTarget({ role: row.role, profile, photoUrl, branchName: branchMap[branchId] ?? '—' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this profile.');
    }
  };

  const exportRow = async (row: ApiGovernanceRow) => {
    try {
      const profile = await apiFetch<Record<string, unknown>>(row.role === 'student' ? `/students/${row.id}/profile` : `/teachers/${row.id}/profile`);
      const recordName = String(profile.name ?? row.name);
      const branchName = branchMap[String(profile.branchId ?? row.branch_id)] ?? '—';
      const roleLabel = row.role === 'teacher' ? (row.is_coordinator ? 'Teacher / Coordinator' : 'Teacher') : 'Student';
      const trValue = row.role === 'student' ? String(profile.trNumber ?? row.tr_number ?? '—') : '—';
      const lines: Array<[string, string]> = [
        ['Name', recordName],
        ['Role', roleLabel],
        ['Branch', branchName],
        ...(row.role === 'student' ? [['TR', trValue] as [string, string]] : []),
        ...Object.entries(profile)
          .filter(([key, value]) => key !== 'id' && key !== 'name' && key !== 'branchId' && key !== 'photoStorageKey' && key !== 'photo_storage_key' && !(Array.isArray(value) || (value !== null && typeof value === 'object')))
          .slice(0, 12)
          .map(([key, value]): [string, string] => [key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase()), String(value ?? '—')]),
      ];

      const pdfBlob = buildProfilePdf(`${recordName} — ${roleLabel}`, lines);
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${recordName.replace(/\s+/g, '-')}-${row.role}-profile.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to export this ${row.role} record.`);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const endpoint = deleteTarget.role === 'student' ? `/students/${deleteTarget.id}` : `/admin/users/${deleteTarget.id}`;
    try {
      await apiFetch(endpoint, { method: 'DELETE' });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete this account.');
    }
  };

  const profileScalars = viewTarget
    ? Object.entries(viewTarget.profile).filter(([key, value]) => key !== 'name' && key !== 'branchId' && key !== 'photoStorageKey' && !Array.isArray(value) && (value === null || typeof value !== 'object'))
    : [];
  const profileCollections = viewTarget
    ? Object.entries(viewTarget.profile).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    : [];

  const showCertificates = section === 'certificates';
  const showGovernance = section === 'governance';

  return (
    <div className={`data-governance-page${showCertificates ? ' certificates-manager-page' : ''}`}>
      <SectionHeading
        eyebrow={showCertificates ? 'Awards & recognition' : 'Account administration'}
        title={showCertificates ? 'Certificates & badges' : 'Data governance'}
        text={showCertificates
          ? 'Choose which certificate each Khat course awards, then review earned certificates for approval.'
          : 'View or export records, or deactivate a student or teacher account while preserving audit history.'}
      />
      {error && <p className="error-text">{error}</p>}

      {showCertificates && <>
      <SectionHeading title="Pending certificate approvals" text="Allocated automatically when a configured primary level is completed or a secondary course is completed — students see certificates after approval." />
      <div className="teacher-table governance-table certificate-approval-table">
        <div className="table-head"><span>Certificate</span><span>Student</span><span>Issued</span><span>Action</span></div>
        {pendingCerts.length === 0 && <div className="governance-empty"><span><Award size={18} /></span><div><strong>No approvals waiting</strong><p>New certificates appear here when students complete an assigned primary level or a secondary course.</p></div></div>}
        {pendingCerts.map(cert => (
          <div className="history-row" key={cert.id}>
            <span data-label="Certificate"><strong>{cert.title}</strong></span>
            <span data-label="Student">{cert.student_name}</span>
            <span data-label="Issued">{new Date(cert.issued_at).toLocaleDateString()}</span>
            <span data-label="Action"><Button onClick={() => approveCert(cert.id)}>Approve</Button> <Button outline onClick={() => rejectCert(cert.id)}>Reject</Button></span>
          </div>
        ))}
      </div>

      <SectionHeading title="Set up a certificate" text="Primary certification courses award a certificate when the selected level is completed. Secondary courses award theirs only after the entire course is completed." />
      <div className="admin-form-card certificate-template-form">
        <label className="field-label">Khat type
          <select className="field" value={awardKhatTypeId} onChange={event => setAwardKhatTypeId(event.target.value)}>
            <option value="">Choose a Khat</option>
            {khatTypesList.map(khat => <option key={khat.id} value={khat.id}>{khat.display_name}</option>)}
          </select>
        </label>
        <label className="field-label">Course type
          <select className="field" value={awardCategory} onChange={event => setAwardCategory(event.target.value as 'certification' | 'secondary')}>
            <option value="certification">Primary certification course · award at a level</option>
            <option value="secondary">Secondary course · award on completion</option>
          </select>
        </label>
        {awardCategory === 'certification' ? (
          <label className="field-label">Award at level
            <select className="field" value={awardLevelId} onChange={event => setAwardLevelId(event.target.value)} disabled={!awardLevels.length}>
              <option value="">{awardLevels.length ? 'Choose a level' : 'No levels available'}</option>
              {awardLevels.map((level, index) => <option key={level.id} value={level.id}>Level {index + 1} · {level.title}{level.level_type === 'test' ? ' (checkpoint)' : ''}</option>)}
            </select>
          </label>
        ) : (
          <label className="field-label">Award when this course is completed
            <select className="field" value={awardCourseId} onChange={event => setAwardCourseId(event.target.value)} disabled={!awardCourses.length}>
              <option value="">{awardCourses.length ? 'Choose a course' : 'No secondary courses available'}</option>
              {awardCourses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}
            </select>
          </label>
        )}
        <label className="field-label">Certificate title
          <input className="field" value={templateTitle} onChange={event => setTemplateTitle(event.target.value)} placeholder="e.g. Naskh Foundation Certificate" />
        </label>
        <UploadBox label={templateFile?.name ?? 'Upload certificate file'} sublabel="PDF or image · drag and drop or browse" accept="application/pdf,.pdf,image/*" onChange={setTemplateFile} />
        <Button onClick={createTemplate} disabled={savingTemplate}>{savingTemplate ? <PenLoader label="Saving certificate" compact tiny /> : 'Add certificate'} {!savingTemplate && <Plus size={15} />}</Button>
      </div>

      <SectionHeading title="Certificate templates" text="Primary templates are tied to the level that earns them; secondary templates are tied to course completion." />
      <div className="teacher-table governance-table certificate-template-table">
        <div className="table-head"><span>Title</span><span>Khat type</span><span>Tied to</span><span>Action</span></div>
        {templates.length === 0 && <div className="governance-empty"><span><FileText size={18} /></span><div><strong>No certificate templates yet</strong><p>Set up a certificate above to enable automatic awards.</p></div></div>}
        {templates.map(t => (
          <div className="history-row" key={t.id}>
            <span data-label="Title"><strong>{t.title}</strong></span>
            <span data-label="Khat type">{khatTypesList.find(k => k.id === t.khat_type_id)?.display_name ?? '—'}</span>
            <span data-label="Tied to">{t.level_id
              ? `${t.course_title ?? 'Primary course'} · Level ${(t.level_order_index ?? 0) + 1}${t.level_title ? ` · ${t.level_title}` : ''}`
              : `${t.course_title ?? 'Course'} · completion${t.course_category === 'certification' ? ' (legacy assignment)' : ''}`}</span>
            <span data-label="Action" className="certificate-template-actions">
              <button className="text-link" onClick={() => viewTemplate(t)}><FileText size={14} /> View</button>
              <button className="text-link danger" onClick={() => deleteTemplate(t.id)}><Trash2 size={14} /> Delete</button>
            </span>
          </div>
        ))}
      </div>

      <SectionHeading title="Badge artwork" text="Choose a custom image or PDF for each script and award tier. Students see a polished default badge when no custom file is set." />
      <div className="admin-form-card badge-artwork-manager">
        <div className="badge-artwork-fields">
          <label className="field-label">Khat type
            <select className="field" value={badgeKhatTypeId} onChange={event => setBadgeKhatTypeId(event.target.value)}>
              {khatTypesList.map(khat => <option key={khat.id} value={khat.id}>{khat.display_name}</option>)}
            </select>
          </label>
          <label className="field-label">Award tier
            <select className="field" value={badgeTier} onChange={event => setBadgeTier(event.target.value as BadgeTier)}>
              <option value="foundation">Foundation</option><option value="composition">Composition</option><option value="mastery">Mastery</option><option value="ijazah">Ijazah</option>
            </select>
          </label>
        </div>
        {(() => {
          const configured = badgeAssets.find(asset => asset.key === `${badgeKhatTypeId}:${badgeTier}`);
          return configured ? (
            <div className="badge-artwork-current">
              <div className="badge-artwork-preview">
                {configured.mediaType === 'image' && configured.url
                  ? <img src={configured.url} alt={`${configured.filename} badge artwork preview`} />
                  : <span className="badge-artwork-pdf"><FileText size={28} /> PDF artwork</span>}
              </div>
              <div className="badge-artwork-current-copy"><strong>{configured.filename}</strong><small>Current artwork · {configured.mediaType.toUpperCase()}</small>{configured.url && <a className="text-link" href={configured.url} target="_blank" rel="noreferrer"><FileText size={14} /> View file</a>}</div>
              <Button outline onClick={() => void removeBadgeAsset(badgeKhatTypeId, badgeTier)}><Trash2 size={14} /> Remove artwork</Button>
            </div>
          ) : (
            <div className="badge-artwork-default"><img src="/mock-badge.svg" alt="Default mock badge preview" /><div><strong>Default mock badge is active</strong><small>Upload custom artwork to replace it for this script and tier.</small></div></div>
          );
        })()}
        <div className="badge-artwork-upload-row">
          <UploadBox label={badgeFile?.name ?? 'Upload badge image or PDF'} sublabel="PNG, JPG, WebP, or PDF · image shown directly, PDFs open as a file" accept="image/*,application/pdf,.pdf" icon={Images} onChange={setBadgeFile} />
          <Button onClick={() => void saveBadgeAsset()} disabled={!badgeFile || savingBadgeAsset}>{savingBadgeAsset ? <PenLoader label="Saving badge artwork" compact tiny /> : 'Save badge artwork'} {!savingBadgeAsset && <ArrowRight size={14} />}</Button>
        </div>
      </div>
      </>}

      {showGovernance && <>
      <SectionHeading title="Account directory" text="Review or export individual records, or deactivate accounts while preserving audit history." />
      <div className="teacher-table governance-table governance-users-table">
        <div className="table-head"><span>Name</span><span>Role</span><span>Branch</span><span>TR</span><span>Actions</span></div>
        {governanceRows.length === 0 && <div className="governance-empty"><span><Users size={18} /></span><div><strong>No active student or teacher accounts</strong><p>Active accounts will appear here for viewing, export, or deactivation.</p></div></div>}
        {governanceRows.map(row => (
          <div className="history-row" key={row.id}>
            <span className="governance-name-cell" data-label="Name"><GovernanceAvatar name={row.name} storageKey={row.photo_storage_key} /><strong>{row.name}</strong></span>
            <span data-label="Role">{row.role === 'teacher' ? `Teacher${row.is_coordinator ? ' / Coordinator' : ''}` : 'Student'}</span>
            <span data-label="Branch">{branchMap[row.branch_id] ?? '—'}</span>
            {row.role === 'student' ? (
              <span data-label="TR">{row.tr_number ?? '—'}</span>
            ) : (
              <span className="governance-no-tr" aria-hidden="true" />
            )}
            <span className="governance-actions-cell" data-label="Actions">
              <Button outline onClick={() => viewRow(row)}>View</Button>
              <Button outline onClick={() => exportRow(row)}>Export</Button>
              <button className="text-link danger" onClick={() => setDeleteTarget({ id: row.id, role: row.role, name: row.name })}><Trash2 size={14} /> Delete</button>
            </span>
          </div>
        ))}
      </div>
      </>}

      {showGovernance && viewTarget && (
        <Modal className="governance-profile-modal-shell" onClose={() => setViewTarget(null)}>
          <div className="governance-profile-modal">
            <header className="governance-profile-header">
              <div className="governance-profile-portrait">{viewTarget.photoUrl ? <img src={viewTarget.photoUrl} alt={`${String(viewTarget.profile.name ?? 'User')} profile`} /> : <span>{String(viewTarget.profile.name ?? '?').trim().slice(0, 1).toUpperCase()}</span>}</div>
              <div className="governance-profile-heading">
                <p className="eyebrow">{viewTarget.role === 'student' ? 'Student profile' : 'Teacher profile'}</p>
                <h2>{String(viewTarget.profile.name ?? 'Profile')}</h2>
                <div><StatusChip tone={viewTarget.role === 'teacher' ? 'blue' : 'green'}>{viewTarget.role === 'teacher' && viewTarget.profile.isCoordinator ? 'Teacher · Coordinator' : viewTarget.role}</StatusChip><span>{viewTarget.branchName}</span></div>
              </div>
            </header>

            <section className="governance-profile-section">
              <div className="governance-profile-section-title"><h3>Account details</h3><span>{profileScalars.length + 1} details</span></div>
              <div className="governance-profile-facts">
                <div><small>Branch</small><strong>{viewTarget.branchName}</strong></div>
                {profileScalars.map(([key, value]) => (
                  <div key={key}><small>{governanceFieldLabel(key)}</small><strong>{governanceFieldValue(key, value, khatTypesList)}</strong></div>
                ))}
              </div>
            </section>

            {profileCollections.map(([key, records]) => (
              <section className="governance-profile-section" key={key}>
                <div className="governance-profile-section-title"><h3>{governanceFieldLabel(key)}</h3><span>{records.length}</span></div>
                {records.length === 0 ? <p className="governance-profile-empty">No {governanceFieldLabel(key).toLowerCase()} recorded.</p> : (
                  <div className="governance-profile-records">
                    {records.map((record, index) => {
                      const fields = record && typeof record === 'object' && !Array.isArray(record)
                        ? Object.entries(record as Record<string, unknown>).filter(([field]) => field !== 'id' && field !== 'student_id' && field !== 'course_id')
                        : [['Detail', record] as [string, unknown]];
                      return (
                        <article className="governance-profile-record" key={`${key}-${index}`}>
                          {fields.map(([field, value]) => <div key={field}><small>{governanceFieldLabel(field)}</small><strong>{governanceFieldValue(field, value, khatTypesList)}</strong></div>)}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            ))}
          </div>
        </Modal>
      )}

      {showGovernance && deleteTarget && (
        <Modal onClose={() => setDeleteTarget(null)}>
          <ShieldCheck size={30} className="red-icon" />
          <p className="eyebrow">Confirm account deactivation</p>
          <h2>Deactivate {deleteTarget.name}?</h2>
          <p>This account will no longer appear in active directories or be able to sign in. Existing submissions and audit history are retained.</p>
          <div className="modal-actions">
            <Button onClick={confirmDelete}>Deactivate account</Button>
            <Button outline onClick={() => setDeleteTarget(null)}>Cancel</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
