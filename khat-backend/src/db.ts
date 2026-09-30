import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

type DbRow = any;
type DbResult = { rows: DbRow[]; rowCount: number };
type DbParams = readonly unknown[];

const mysqlPool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10_000,
  timezone: 'Z',
  // Keep DATE columns as calendar strings, while DATETIME values become UTC
  // Date objects and serialize like node-postgres timestamp responses did.
  dateStrings: ['DATE'],
  charset: 'utf8mb4',
  typeCast(field, next) {
    // PostgreSQL returned booleans as JS booleans; the converted MySQL schema
    // stores them as TINYINT(1), so preserve that API behavior.
    if (field.type === 'TINY' && field.length === 1) {
      const value = field.string();
      return value === null ? null : value === '1';
    }
    return next();
  },
});

mysqlPool.on('connection', connection => {
  void connection.query("SET time_zone = '+00:00'").catch(error => {
    console.error('Failed to set MySQL session timezone to UTC', error);
  });
});

const RESERVED_COLUMNS = new Set(['key', 'read', 'value', 'rank']);

function quoteIdentifiers(sql: string): string {
  let result = '';
  for (let i = 0; i < sql.length;) {
    const char = sql[i];
    if (char === "'") {
      const start = i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === '\\') { i += 2; continue; }
        if (sql[i++] === "'") break;
      }
      result += sql.slice(start, i);
      continue;
    }
    if (char === '"') {
      let value = '';
      i++;
      while (i < sql.length && sql[i] !== '"') value += sql[i++];
      if (sql[i] === '"') i++;
      result += `\`${value}\``;
      continue;
    }
    if (char === '`') {
      const start = i++;
      while (i < sql.length && sql[i] !== '`') i++;
      if (sql[i] === '`') i++;
      result += sql.slice(start, i);
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      const word = sql.slice(start, i);
      const previousText = sql.slice(0, start).trimEnd();
      const isDuplicateKeyClause = word.toUpperCase() === 'KEY' && /\bDUPLICATE$/i.test(previousText);
      result += RESERVED_COLUMNS.has(word.toLowerCase()) && !isDuplicateKeyClause ? `\`${word}\`` : word;
      continue;
    }
    result += char;
    i++;
  }
  return result;
}

function conflictNoopColumn(sql: string): string {
  const match = sql.match(/\bINSERT(?:\s+IGNORE)?\s+INTO\s+[`\w]+\s*\(([^)]+)\)/i);
  const firstColumn = match?.[1].split(',')[0]?.trim();
  return firstColumn || 'id';
}

function translateFilteredCounts(sql: string): string {
  let result = '';
  let cursor = 0;
  const countPattern = /COUNT\s*\(/ig;
  let match: RegExpExecArray | null;

  while ((match = countPattern.exec(sql))) {
    let depth = 1;
    let end = match.index + match[0].length;
    for (; end < sql.length && depth > 0; end++) {
      if (sql[end] === '(') depth++;
      else if (sql[end] === ')') depth--;
    }
    if (depth !== 0) continue;
    const aggregateEnd = end;
    const suffix = sql.slice(aggregateEnd).match(/^\s*FILTER\s*\(/i);
    if (!suffix) continue;

    let filterStart = aggregateEnd + suffix[0].length;
    depth = 1;
    let filterEnd = filterStart;
    for (; filterEnd < sql.length && depth > 0; filterEnd++) {
      if (sql[filterEnd] === '(') depth++;
      else if (sql[filterEnd] === ')') depth--;
    }
    if (depth !== 0) continue;

    const expression = sql.slice(match.index + match[0].length, aggregateEnd - 1).trim();
    const condition = sql.slice(filterStart, filterEnd - 1).replace(/^\s*WHERE\s+/i, '').trim();
    const replacement = expression === '*'
      ? `COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0)`
      : `COUNT(CASE WHEN ${condition} THEN ${expression} ELSE NULL END)`;
    result += sql.slice(cursor, match.index) + replacement;
    cursor = filterEnd;
    countPattern.lastIndex = filterEnd;
  }
  return result ? result + sql.slice(cursor) : sql;
}

export function translatePostgresSql(sql: string, params: DbParams = []): { sql: string; values: unknown[] } {
  let translated = translateFilteredCounts(sql);
  translated = translated
    .replace(/\bON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+NOTHING\b/gi, () => {
      const column = conflictNoopColumn(sql);
      return `ON DUPLICATE KEY UPDATE ${column} = ${column}`;
    })
    .replace(/\bON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\b/gi, 'ON DUPLICATE KEY UPDATE')
    .replace(/\bEXCLUDED\.([A-Za-z_][\w]*)/gi, 'VALUES(`$1`)')
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/::\s*[A-Za-z_][\w]*(?:\[\])?/g, '');
  translated = quoteIdentifiers(translated);

  const values: unknown[] = [];
  translated = translated.replace(/\$(\d+)/g, (_placeholder, indexText: string) => {
    const index = Number(indexText) - 1;
    if (index < 0 || index >= params.length) {
      throw new Error(`SQL placeholder $${index + 1} has no matching parameter`);
    }
    const value = params[index];
    values.push(value instanceof Date || Buffer.isBuffer(value) || value === null || value === undefined
      ? value ?? null
      : Array.isArray(value) || (typeof value === 'object' && value !== null)
        ? JSON.stringify(value)
        : value);
    return '?';
  });

  return { sql: translated, values };
}

function resultFromMysql(result: unknown): DbResult {
  if (Array.isArray(result)) {
    const rows = result as (RowDataPacket & DbRow)[];
    return { rows, rowCount: rows.length };
  }
  const header = result as ResultSetHeader;
  return { rows: [], rowCount: header.affectedRows ?? 0 };
}

class MysqlConnectionAdapter {
  private inTransaction = false;

  constructor(private readonly connection: PoolConnection) {}

  async query(sql: string, params: DbParams = []): Promise<DbResult> {
    const command = sql.trim().replace(/;$/, '').toUpperCase();
    if (command === 'BEGIN' || command === 'BEGIN TRANSACTION') {
      await this.connection.beginTransaction();
      this.inTransaction = true;
      return { rows: [], rowCount: 0 };
    }
    if (command === 'COMMIT') {
      await this.connection.commit();
      this.inTransaction = false;
      return { rows: [], rowCount: 0 };
    }
    if (command === 'ROLLBACK') {
      await this.connection.rollback();
      this.inTransaction = false;
      return { rows: [], rowCount: 0 };
    }

    const returning = sql.match(/\s+RETURNING\s+([\s\S]*?)\s*;?\s*$/i);
    if (returning) return this.queryReturning(sql.slice(0, returning.index), returning[1], params);
    return this.queryRaw(sql, params);
  }

  release(): void {
    if (this.inTransaction) void this.connection.rollback().finally(() => this.connection.release());
    else this.connection.release();
  }

  private async queryRaw(sql: string, params: DbParams = []): Promise<DbResult> {
    const converted = translatePostgresSql(sql, params);
    const [result] = await this.connection.query(converted.sql, converted.values as never[]);
    return resultFromMysql(result);
  }

  private async queryReturning(sql: string, projection: string, params: DbParams): Promise<DbResult> {
    const insert = sql.match(/^\s*INSERT(?:\s+IGNORE)?\s+INTO\s+(`?[A-Za-z_][\w]*`?)\s*\(([^)]*)\)([\s\S]*)$/i);
    const update = sql.match(/^\s*UPDATE\s+(`?[A-Za-z_][\w]*`?)([\s\S]*)$/i);
    const deletion = sql.match(/^\s*DELETE\s+FROM\s+(`?[A-Za-z_][\w]*`?)([\s\S]*)$/i);
    const table = insert?.[1] ?? update?.[1] ?? deletion?.[1];
    if (!table) throw new Error('MySQL RETURNING compatibility supports simple INSERT, UPDATE, and DELETE statements only');

    const ownsTransaction = !this.inTransaction;
    if (ownsTransaction) {
      await this.connection.beginTransaction();
      this.inTransaction = true;
    }

    try {
      let result: DbResult;
      if (insert) {
        const generatedId = randomUUID();
        const insertSql = this.addGeneratedId(sql, insert[1], insert[2], insert[3], generatedId);
        const insertResult = await this.queryRaw(insertSql, params);
        if (insertResult.rowCount === 0) {
          result = { rows: [], rowCount: 0 };
        } else {
          const selected = await this.queryRaw(`SELECT ${projection} FROM ${table} WHERE id = '${generatedId}'`);
          result = { rows: selected.rows, rowCount: selected.rows.length };
        }
      } else {
        const match = update ?? deletion;
        const where = match?.[2].match(/\bWHERE\s+([\s\S]+)$/i);
        if (!where) throw new Error('MySQL RETURNING compatibility requires a WHERE clause for UPDATE and DELETE');
        const ids = await this.queryRaw(`SELECT id FROM ${table} WHERE ${where[1]} FOR UPDATE`, params);
        if (!ids.rows.length) {
          await this.queryRaw(sql, params);
          result = { rows: [], rowCount: 0 };
        } else if (update) {
          await this.queryRaw(sql, params);
          const idValues = ids.rows.map(row => row.id);
          const placeholders = idValues.map((_, index) => `$${index + 1}`);
          const orderPlaceholders = idValues.map((_, index) => `$${idValues.length + index + 1}`);
          const selectSql = `SELECT ${projection} FROM ${table} WHERE id IN (${placeholders.join(', ')}) ORDER BY FIELD(id, ${orderPlaceholders.join(', ')})`;
          const selected = await this.queryRaw(selectSql, [...idValues, ...idValues]);
          result = { rows: selected.rows, rowCount: selected.rows.length };
        } else {
          const idValues = ids.rows.map(row => row.id);
          const placeholders = idValues.map((_, index) => `$${index + 1}`).join(', ');
          const selected = await this.queryRaw(`SELECT ${projection} FROM ${table} WHERE id IN (${placeholders})`, idValues);
          await this.queryRaw(sql, params);
          result = { rows: selected.rows, rowCount: selected.rows.length };
        }
      }

      if (ownsTransaction) {
        await this.connection.commit();
        this.inTransaction = false;
      }
      return result;
    } catch (error) {
      if (ownsTransaction) {
        await this.connection.rollback();
        this.inTransaction = false;
      }
      throw error;
    }
  }

  private addGeneratedId(sql: string, table: string, columnsText: string, tail: string, id: string): string {
    if (columnsText.split(',').some(column => column.trim().replace(/`/g, '').toLowerCase() === 'id')) {
      throw new Error(`Cannot emulate RETURNING for ${table}: insert explicitly supplies its id`);
    }
    let insertTail: string;
    if (/\bVALUES\s*\(/i.test(tail)) {
      insertTail = tail.replace(/\bVALUES\s*\(/i, `VALUES ('${id}', `);
    } else if (/\bSELECT\b/i.test(tail)) {
      insertTail = tail.replace(/\bSELECT\b/i, `SELECT '${id}',`);
    } else {
      throw new Error(`Cannot emulate RETURNING for ${table}: unsupported INSERT form`);
    }
    const prefix = sql.slice(0, sql.indexOf('('));
    return `${prefix}(id, ${columnsText})${insertTail}`;
  }
}

class MysqlPoolAdapter {
  async query(sql: string, params: DbParams = []): Promise<DbResult> {
    const connection = await mysqlPool.getConnection();
    const adapter = new MysqlConnectionAdapter(connection);
    try {
      return await adapter.query(sql, params);
    } finally {
      adapter.release();
    }
  }

  async connect(): Promise<MysqlConnectionAdapter> {
    return new MysqlConnectionAdapter(await mysqlPool.getConnection());
  }

  async end(): Promise<void> {
    await mysqlPool.end();
  }
}

export const pool = new MysqlPoolAdapter();
