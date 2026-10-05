import mysql from 'mysql2/promise';
import type { Pool as MysqlPool, PoolConnection } from 'mysql2/promise';
import { config } from './config.js';

// MariaDB/MySQL adapter that keeps the original `pg`-style API (`pool.query(sql, params)`
// -> `{ rows, rowCount }`, `pool.connect()` -> client with `query`/`release`) so route code
// can keep its PostgreSQL-flavoured SQL. `translate()` rewrites the handful of PostgreSQL-only
// constructs the app uses ($n placeholders, ::casts, ILIKE, ON CONFLICT, "quoted" identifiers,
// UPDATE ... RETURNING). Anything fancier (generate_series, FILTER, date_trunc ...) is written
// in MariaDB syntax directly in the routes.

export type QueryResult<T = any> = { rows: T[]; rowCount: number | null };

// MariaDB stores JSON as LONGTEXT, so parse these columns back into values like pg did.
const JSON_COLUMNS = new Set(['tags', 'media', 'sheet_files', 'payload', 'value']);

type Tok = { sql: string; params: unknown[] };

// Walk the SQL, calling `fn` for text outside '...' strings and "..." identifiers.
function mapOutsideStrings(sql: string, fn: (chunk: string) => string, dq?: (ident: string) => string): string {
  let out = '';
  let buf = '';
  let i = 0;
  const flush = () => {
    out += fn(buf);
    buf = '';
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      flush();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '"') {
      flush();
      const j = sql.indexOf('"', i + 1);
      const ident = sql.slice(i + 1, j);
      out += dq ? dq(ident) : sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      flush();
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? sql.length : j;
      out += sql.slice(i, end); // keep SQL comments verbatim, they may contain quotes/$n
      i = end;
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  return out;
}


const MONTH_START = `CAST(DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') AS DATE)`;

// Rewrites that need to see string literals (so they run before the quote-aware pass).
function rewriteFunctions(sql: string): string {
  return (
    sql
      // WITH months AS (SELECT generate_series(first_of_month - N months, first_of_month, 1 month) AS month_start)
      .replace(
        /WITH\s+months\s+AS\s*\(\s*SELECT\s+generate_series\(\s*date_trunc\('month',\s*CURRENT_DATE\)\s*-\s*(?:INTERVAL\s+'(\d+)\s+months?'|\(\(\s*(\$\d+)(?:::int)?\s*-\s*1\)\s*\*\s*INTERVAL\s+'1 month'\))\s*,\s*date_trunc\('month',\s*CURRENT_DATE\)\s*,\s*INTERVAL\s+'1 month'\s*\)\s*AS\s+month_start\s*\)/gi,
        (_m, fixed, param) =>
          `WITH RECURSIVE months(month_start) AS (SELECT DATE_SUB(${MONTH_START}, INTERVAL ${fixed ?? `(${param} - 1)`} MONTH) ` +
          `UNION ALL SELECT DATE_ADD(month_start, INTERVAL 1 MONTH) FROM months WHERE month_start < ${MONTH_START})`
      )
      .replace(/date_trunc\(\s*'month'\s*,\s*([^(),]+?)\s*\)/gi, `CAST(DATE_FORMAT($1, '%Y-%m-01') AS DATE)`)
      .replace(/INTERVAL\s+'(\d+)\s+(day|month|hour|minute)s?'/gi, (_m, n, u) => `INTERVAL ${n} ${u.toUpperCase()}`)
      .replace(/to_char\(\s*([^(),]+?)\s*,\s*'YYYY-MM'\s*\)/gi, `DATE_FORMAT($1, '%Y-%m')`)
      .replace(
        /EXTRACT\(\s*EPOCH\s+FROM\s*\(\s*([\w.]+)\s*-\s*([\w.]+)\s*\)\s*\)/gi,
        'TIMESTAMPDIFF(SECOND, $2, $1)'
      )
      // COUNT(x) FILTER (WHERE cond)  ->  COUNT(CASE WHEN cond THEN x END)
      .replace(
        /COUNT\(\s*(\*|[\w.]+)\s*\)\s+FILTER\s*\(\s*WHERE\s+((?:[^()]|\([^()]*\))+)\)/gi,
        (_m, arg, cond) => `COUNT(CASE WHEN ${cond.trim()} THEN ${arg === '*' ? '1' : arg} END)`
      )
  );
}

function translate(text: string, values: unknown[] = []): Tok {
  const params: unknown[] = [];
  let sql = mapOutsideStrings(
    rewriteFunctions(text),
    (chunk) =>
      chunk
        .replace(/::(?:int|integer|bigint|boolean|text|uuid|numeric|date|timestamptz|timestamp|jsonb|json)(?:\[\])?/gi, '')
        .replace(/\bILIKE\b/gi, 'LIKE')
        .replace(/(?<![`\w])(key|read)\b(?![`\w])/gi, '`$1`') // reserved words in MariaDB
        .replace(/(\b(?:LIMIT|OFFSET)\s+)\$(\d+)/gi, (_m, kw, n) => {
          params.push(Number(values[Number(n) - 1]));
          return `${kw}?`;
        })
        .replace(/\$(\d+)/g, (_m, n) => {
          params.push(toParam(values[Number(n) - 1]));
          return '?';
        }),
    (ident) => '`' + ident + '`'
  );

  // ON CONFLICT ... DO NOTHING  ->  INSERT IGNORE
  if (/\bON\s+CONFLICT\b[^;]*?\bDO\s+NOTHING\b/i.test(sql)) {
    sql = sql
      .replace(/\bON\s+CONFLICT\s*(\([^)]*\))?\s*DO\s+NOTHING\b/i, '')
      .replace(/^(\s*)INSERT\s+INTO\b/i, '$1INSERT IGNORE INTO');
  }
  // ON CONFLICT (...) DO UPDATE SET a = EXCLUDED.a  ->  ON DUPLICATE KEY UPDATE a = VALUES(a)
  sql = sql
    .replace(/\bON\s+CONFLICT\s*(\([^)]*\))?\s*DO\s+UPDATE\s+SET\b/i, 'ON DUPLICATE KEY UPDATE')
    .replace(/\bEXCLUDED\.(\w+)/gi, 'VALUES($1)');

  return { sql, params };
}

function toParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || v instanceof Date || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
  return v;
}

// Positions of top-level (outside parentheses/strings) keywords.
function topLevel(sql: string, word: string): number {
  let depth = 0;
  let found = -1;
  const re = new RegExp(`^${word}\\b`, 'i');
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
    } else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /\s/.test(sql[i - 1] ?? ' ') && re.test(sql.slice(i))) found = i; // last occurrence
  }
  return found;
}

// count '?' placeholders, ignoring any inside string literals
const countParams = (s: string) => {
  let n = 0;
  mapOutsideStrings(s, (c) => ((n += (c.match(/\?/g) ?? []).length), c));
  return n;
};

function fixRow(row: any) {
  for (const col of JSON_COLUMNS) {
    const v = row[col];
    if (typeof v === 'string') {
      try {
        row[col] = JSON.parse(v);
      } catch {
        /* leave as plain text */
      }
    }
  }
  return row;
}

function mapError(err: any) {
  const code = err?.code;
  if (code === 'ER_DUP_ENTRY') err.code = '23505';
  else if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2') err.code = '23503';
  else if (code === 'ER_CONSTRAINT_FAILED' || code === 'ER_CHECK_CONSTRAINT_VIOLATED') err.code = '23514';
  return err;
}

type Queryable = Pick<MysqlPool, 'query'>;

async function raw(conn: Queryable, sql: string, params: unknown[]): Promise<QueryResult> {
  try {
    const [res] = await conn.query(sql, params);
    if (Array.isArray(res)) {
      const rows = (res as any[]).map(fixRow);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: (res as any).affectedRows ?? 0 };
  } catch (err) {
    throw mapError(err);
  }
}

async function run(conn: Queryable, text: string, values?: unknown[]): Promise<QueryResult> {
  const { sql, params } = translate(text, values);

  // MariaDB has no UPDATE ... RETURNING: find the matching ids first, update, then re-select them.
  const ret = /^\s*UPDATE\b/i.test(sql) ? topLevel(sql, 'RETURNING') : -1;
  if (ret !== -1) {
    const m = /^\s*UPDATE\s+(\w+)\s+(?:(?:AS\s+)?(?!SET\b)(\w+)\s+)?SET\b/i.exec(sql);
    if (!m) throw new Error('Unsupported UPDATE ... RETURNING: ' + sql.slice(0, 80));
    const [, table, alias] = m;
    const retCols = sql.slice(ret).replace(/^RETURNING\s+/i, '').trim();
    const body = sql.slice(0, ret);
    const w = topLevel(body, 'WHERE');
    const where = w === -1 ? '' : body.slice(w + 5);
    const setPart = w === -1 ? body : body.slice(0, w);
    const wherePrms = w === -1 ? [] : params.slice(countParams(setPart), countParams(setPart) + countParams(where));
    const from = `${table}${alias ? ' ' + alias : ''}`;
    const idCol = alias ? `${alias}.id` : 'id';

    const { rows: idRows } = await raw(conn, `SELECT ${idCol} AS id FROM ${from}${where ? ' WHERE ' + where : ''}`, wherePrms);
    if (!idRows.length) return { rows: [], rowCount: 0 };
    const upd = await raw(conn, body, params);
    const ids = idRows.map((r) => r.id);
    const sel = await raw(conn, `SELECT ${retCols} FROM ${from} WHERE ${idCol} IN (?)`, [ids]);
    return { rows: sel.rows, rowCount: upd.rowCount };
  }

  return raw(conn, sql, params);
}

const pool0 = mysql.createPool({
  uri: config.databaseUrl,
  connectionLimit: 10,
  waitForConnections: true,
  connectTimeout: 10_000,
  charset: 'utf8mb4',
  timezone: 'Z',
  decimalNumbers: true, // SUM()/AVG() come back as numbers, like the ::int / numeric casts expected
  flags: ['+FOUND_ROWS'], // rowCount = rows matched, like PostgreSQL
  typeCast(field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      const v = field.string();
      return v === null ? null : v === '1';
    }
    return next();
  },
});

// Every new connection: UTC, `||` as string concatenation (PostgreSQL behaviour).
pool0.pool.on('connection', (conn: any) => {
  conn.query("SET time_zone = '+00:00', sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')");
});

export type DbClient = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult>;
  release: () => void;
};

export const pool = {
  query: (text: string, values?: unknown[]) => run(pool0, text, values),
  async connect(): Promise<DbClient> {
    const conn: PoolConnection = await pool0.getConnection();
    return {
      query: (text, values) => run(conn, text, values),
      release: () => conn.release(),
    };
  },
  end: () => pool0.end(),
};
