#!/usr/bin/env node
/**
 * Convert the plain-text pg_dump used by this workspace into a MySQL 8.0.16+
 * schema/data script. This translates the dump format, not application SQL or
 * database-driver code. Usage: node scripts/convert-postgres-dump-to-mysql.mjs input.sql output.mysql.sql
 */
import fs from 'node:fs';
import path from 'node:path';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/convert-postgres-dump-to-mysql.mjs input.sql output.mysql.sql');
  process.exit(2);
}

const source = fs.readFileSync(inputPath, 'utf8');
const mysql = [];
const tables = new Map();
const primaryAndUnique = [];
const foreignKeys = [];
const indexes = [];
const checkConstraints = [];
const jsonColumns = new Set(['media', 'sheet_files', 'payload', 'value', 'tags']);
const numericColumns = new Set([
  'activity_log.login_count',
  'competition_winners.rank',
  'enrollments.current_level_index',
  'enrollments.percent_complete',
  'level_submissions.time_spent_minutes',
  'levels.order_index',
  'users.entry_load_threshold',
]);
let totalRows = 0;

function sqlString(value) {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  return `CONVERT(X'${hex}' USING utf8mb4)`;
}

function copyUnescape(value) {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') { result += value[i]; continue; }
    const next = value[++i];
    if (next === undefined) { result += '\\'; break; }
    const replacements = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
    if (Object.hasOwn(replacements, next)) result += replacements[next];
    else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(value[i + 1] ?? '')) octal += value[++i];
      result += String.fromCharCode(Number.parseInt(octal, 8));
    } else if (next === 'x') {
      let hex = '';
      while (hex.length < 2 && /[0-9a-f]/i.test(value[i + 1] ?? '')) hex += value[++i];
      result += hex ? String.fromCharCode(Number.parseInt(hex, 16)) : 'x';
    } else result += next;
  }
  return result;
}

function parsePgArray(value) {
  if (value === '{}') return [];
  if (!value.startsWith('{') || !value.endsWith('}')) throw new Error(`Unsupported PostgreSQL array value: ${value.slice(0, 80)}`);
  const items = [];
  let item = '';
  let quoted = false;
  let escaped = false;
  for (const char of value.slice(1, -1)) {
    if (escaped) { item += char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { items.push(item); item = ''; }
    else item += char;
  }
  if (escaped || quoted) throw new Error('Malformed PostgreSQL array value');
  if (item.length || value !== '{}') items.push(item);
  return items;
}

function mysqlValue(value, table, column) {
  if (value === null) return 'NULL';
  if (column === 'tags') value = JSON.stringify(parsePgArray(value));
  if (jsonColumns.has(column)) return `CAST(${sqlString(value)} AS JSON)`;
  if (['used', 'read', 'is_coordinator', 'watched_recording', 'is_deletable', 'must_change_password', 'idle_flagged', 'is_diverted'].includes(column)) {
    if (value === 't') return '1';
    if (value === 'f') return '0';
  }
  if (numericColumns.has(`${table}.${column}`)) {
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw new Error(`Invalid numeric value for ${table}.${column}: ${value}`);
    return value;
  }
  // MySQL DATETIME has no timezone. Normalize PostgreSQL's explicit offset to UTC.
  const timestamp = value.match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?([+-])(\d\d)(?::?(\d\d))?$/);
  if (timestamp) {
    const [, datePart, timePart, fraction = '', sign, offsetHours, offsetMinutes = '00'] = timestamp;
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second] = timePart.split(':').map(Number);
    const offsetMinutesSigned = (Number(offsetHours) * 60 + Number(offsetMinutes)) * (sign === '+' ? 1 : -1);
    const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutesSigned * 60_000);
    const utcWholeSecond = utc.toISOString().slice(0, 19).replace('T', ' ');
    const micros = fraction ? fraction.slice(1).padEnd(6, '0').slice(0, 6) : '';
    value = `${utcWholeSecond}${micros ? `.${micros}` : ''}`;
  } else if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(value) && /Z$/.test(value)) {
    value = value.replace('T', ' ').replace(/Z$/, '');
  }
  return sqlString(value);
}

function mysqlType(table, column, pgType) {
  const lower = pgType.toLowerCase();
  if (lower.startsWith('uuid')) return 'CHAR(36)';
  if (lower.startsWith('text[]')) return 'JSON';
  if (lower.startsWith('jsonb') || lower.startsWith('json')) return 'JSON';
  if (lower.startsWith('tsvector')) return 'LONGTEXT';
  if (lower.startsWith('timestamp with time zone')) return 'DATETIME(6)';
  if (lower.startsWith('timestamp without time zone') || lower === 'timestamp') return 'DATETIME(6)';
  if (lower.startsWith('character varying')) return pgType.replace(/character varying/i, 'VARCHAR');
  if (lower.startsWith('numeric')) return pgType.replace(/numeric/i, 'DECIMAL');
  if (lower === 'integer') return 'INT';
  if (lower === 'bigint') return 'BIGINT';
  if (lower === 'smallint') return 'SMALLINT';
  if (lower === 'boolean') return 'TINYINT(1)';
  if (lower === 'date') return 'DATE';
  if (lower === 'text') {
    if (column === 'email') return 'VARCHAR(320)';
    if (column === 'tr_number') return 'VARCHAR(50)';
    if (column === 'key') return 'VARCHAR(191)';
    if (table === 'branches' && column === 'name') return 'VARCHAR(255)';
    if (table === 'khat_types' && column === 'code') return 'VARCHAR(100)';
    if (['role', 'category', 'status', 'tier', 'code', 'level_type', 'source_type', 'action', 'type', 'user_role'].includes(column)) return 'VARCHAR(64)';
    return 'LONGTEXT';
  }
  return pgType;
}

function translateDefault(expression, column) {
  let value = expression.trim().replace(/::[a-zA-Z_][\w]*(?:\[\])?/g, '');
  if (/^gen_random_uuid\(\)$/i.test(value)) return 'DEFAULT (UUID())';
  if (/^now\(\)$/i.test(value)) return 'DEFAULT CURRENT_TIMESTAMP(6)';
  if (/^true$/i.test(value)) return 'DEFAULT 1';
  if (/^false$/i.test(value)) return 'DEFAULT 0';
  if (column === 'tags' && value === "'{}'") return 'DEFAULT (JSON_ARRAY())';
  if (column === 'media' && value === "'[]'") return 'DEFAULT (JSON_ARRAY())';
  if (column === 'sheet_files' && value === "'{}'") return 'DEFAULT (JSON_OBJECT())';
  if (column === 'payload' && value === "'{}'") return 'DEFAULT (JSON_OBJECT())';
  if (value.startsWith("'") && value.endsWith("'")) {
    const literal = value.slice(1, -1).replace(/''/g, "'").replace(/\\/g, '\\\\').replace(/'/g, "''");
    return `DEFAULT '${literal}'`;
  }
  return `DEFAULT ${value}`;
}

function translateCheck(line) {
  const match = line.match(/^CONSTRAINT\s+(\w+)\s+CHECK\s+\(\((\w+)\s*=\s*ANY\s*\(ARRAY\[(.*)\]\)\)\),?$/i);
  if (!match) return null;
  const [, name, column, rawValues] = match;
  const values = [...rawValues.matchAll(/'((?:[^']|'')*)'(?:::\w+)?/g)].map(item => sqlString(item[1].replace(/''/g, "'")));
  if (!values.length) return null;
  return `CONSTRAINT \`${name}\` CHECK (\`${column}\` IN (${values.join(', ')}))`;
}

function createTableSql(tableName, body) {
  const definitions = [];
  for (let line of body.split(/\n/).map(value => value.trim()).filter(Boolean)) {
    line = line.replace(/,$/, '');
    if (line.startsWith('CONSTRAINT ')) {
      const check = translateCheck(line);
      if (check) definitions.push(check);
      else throw new Error(`Unsupported table constraint in ${tableName}: ${line}`);
      continue;
    }
    const match = line.match(/^(\w+)\s+(.+)$/);
    if (!match) throw new Error(`Cannot parse column definition in ${tableName}: ${line}`);
    const [, column, rest] = match;
    const typeMatch = rest.match(/^(.+?)(?=\s+(?:DEFAULT|NOT NULL|NULL|COLLATE)\b|$)/i);
    if (!typeMatch) throw new Error(`Cannot parse type for ${tableName}.${column}`);
    const pgType = typeMatch[1].trim();
    const isArray = /\[\]$/.test(pgType);
    const normalizedPgType = pgType.replace(/\[\]$/, '');
    let definition = `\`${column}\` ${mysqlType(tableName, column, isArray ? `${normalizedPgType}[]` : normalizedPgType)}`;
    const defaultMatch = rest.match(/\s+DEFAULT\s+(.+?)(?=\s+NOT NULL|\s+NULL|$)/i);
    if (defaultMatch) definition += ` ${translateDefault(defaultMatch[1], column)}`;
    if (/\bNOT NULL\b/i.test(rest)) definition += ' NOT NULL';
    definitions.push(definition);
  }
  if (tableName === 'courses') {
    definitions.push('`certification_guard` TINYINT GENERATED ALWAYS AS (CASE WHEN `category` = \'certification\' THEN 1 ELSE NULL END) STORED');
  }
  tables.set(tableName, true);
  return `CREATE TABLE \`${tableName}\` (\n  ${definitions.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`;
}

// Parse regular pg_dump table definitions.
const tablePattern = /CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/g;
let tableMatch;
while ((tableMatch = tablePattern.exec(source))) {
  mysql.push(createTableSql(tableMatch[1], tableMatch[2]));
}
if (tables.size === 0) throw new Error('No public CREATE TABLE statements found.');

// Preserve primary keys, unique constraints and foreign keys as MySQL ALTER statements.
for (const match of source.matchAll(/ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT (\w+) PRIMARY KEY \(([^;]+)\);/g)) {
  primaryAndUnique.push(`ALTER TABLE \`${match[1]}\` ADD CONSTRAINT \`${match[2]}\` PRIMARY KEY (${match[3].split(',').map(value => `\`${value.trim()}\``).join(', ')});`);
}
for (const match of source.matchAll(/ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT (\w+) UNIQUE \(([^;]+)\);/g)) {
  primaryAndUnique.push(`ALTER TABLE \`${match[1]}\` ADD CONSTRAINT \`${match[2]}\` UNIQUE (${match[3].split(',').map(value => `\`${value.trim()}\``).join(', ')});`);
}
for (const match of source.matchAll(/ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT (\w+) FOREIGN KEY \(([^)]+)\) REFERENCES public\.(\w+)\(([^)]+)\)(?: ON DELETE (CASCADE|SET NULL|RESTRICT))?;/g)) {
  const [, table, name, columns, refTable, refColumns, deleteAction] = match;
  const local = columns.split(',').map(value => `\`${value.trim()}\``).join(', ');
  const referenced = refColumns.split(',').map(value => `\`${value.trim()}\``).join(', ');
  foreignKeys.push(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\` FOREIGN KEY (${local}) REFERENCES \`${refTable}\` (${referenced})${deleteAction ? ` ON DELETE ${deleteAction}` : ''};`);
}

// Convert COPY ... FROM stdin data blocks into portable UTF-8 INSERT statements.
const copyPattern = /^COPY public\.(\w+) \(([^)]+)\) FROM stdin;\r?\n([\s\S]*?)^\\\.\s*$/gm;
let copyMatch;
while ((copyMatch = copyPattern.exec(source))) {
  const [, table, rawColumns, block] = copyMatch;
  const columns = rawColumns.split(',').map(value => value.trim());
  const rows = block.replace(/\r/g, '').split('\n').filter(line => line.length > 0);
  for (const row of rows) {
    const cells = row.split('\t');
    if (cells.length !== columns.length) throw new Error(`COPY row has ${cells.length} columns, expected ${columns.length} in ${table}`);
    const values = cells.map((cell, index) => cell === '\\N' ? null : copyUnescape(cell));
    mysql.push(`INSERT INTO \`${table}\` (${columns.map(column => `\`${column}\``).join(', ')}) VALUES (${values.map((value, index) => mysqlValue(value, table, columns[index])).join(', ')});`);
    totalRows++;
  }
}
if (totalRows === 0) throw new Error('No COPY data blocks were converted.');

// Convert ordinary btree indexes; full-text GIN and partial predicates are translated separately.
for (const match of source.matchAll(/CREATE INDEX (\w+) ON public\.(\w+) USING btree \(([^)]+)\)(?: WHERE \(([^;]+)\))?;/g)) {
  const [, name, table, columns] = match;
  indexes.push(`CREATE INDEX \`${name}\` ON \`${table}\` (${columns.split(',').map(column => column.trim().replace(/\s+DESC$/i, ' DESC').replace(/\s+ASC$/i, ' ASC').replace(/^(\w+)/, '`$1`')).join(', ')});`);
}
indexes.push('CREATE FULLTEXT INDEX `idx_assets_search` ON `assets` (`title`);');
indexes.push('CREATE UNIQUE INDEX `uq_one_certification_course_per_khat_type` ON `courses` (`khat_type_id`, `certification_guard`);');

mysql.unshift(
  '-- Converted from a plain PostgreSQL pg_dump for MySQL 8.0.16+.',
  '-- UUIDs are stored as CHAR(36); PostgreSQL text arrays are converted to JSON.',
  '-- PostgreSQL tsvector data is retained as LONGTEXT; application search uses the MySQL full-text title index and JSON tag matching.',
  '-- This translates the database dump; the Node backend connects through mysql2 and its MySQL compatibility adapter.',
  'SET NAMES utf8mb4;',
  'SET FOREIGN_KEY_CHECKS = 0;',
  'START TRANSACTION;'
);
mysql.push(...primaryAndUnique, ...indexes, ...foreignKeys, 'SET FOREIGN_KEY_CHECKS = 1;', 'COMMIT;');

const output = path.resolve(outputPath);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${mysql.join('\n\n')}\n`, 'utf8');
console.log(`Converted ${tables.size} tables and ${totalRows} data rows to ${output}`);
