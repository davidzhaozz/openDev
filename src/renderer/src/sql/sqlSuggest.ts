// Type-ahead hint engine for the SQL query window.
//
// This is *not* a parser and it never touches the database. It looks at the
// statement the caret sits in, decides "what could legally come next here",
// and returns hint items. Typing `CRE` suggests `CREATE DATABASE …`; once
// you've typed `CREATE DATABASE shop ` it suggests `OWNER`, `ENCODING`, `;`
// and friends. Schema-aware bits (tables / columns) are filled in from the
// DbSchema we already fetch for the connection tree.

import type { DbSchema } from '../../../shared/types';

export type SqlDriver = 'mysql' | 'postgres';

export type SqlSuggestionKind =
  | 'keyword' | 'snippet' | 'table' | 'column' | 'schema' | 'function' | 'placeholder';

export type SqlSuggestion = {
  /** Shown in the popup. */
  label: string;
  /** Text actually inserted, replacing the partial word under the caret. */
  insert: string;
  kind: SqlSuggestionKind;
  /** Dim right-hand text in the popup ("keyword", "table", "int · users"). */
  detail?: string;
  /** One-line explanation shown in the popup footer for the selected row. */
  doc?: string;
  /** Caret placement relative to the END of `insert` (0 or negative). */
  cursorOffset?: number;
  /** Select the inserted text so the next keystroke overwrites it. */
  selectInserted?: boolean;
};

export type SuggestInput = {
  text: string;
  cursor: number;
  driver?: SqlDriver;
  schema?: DbSchema[] | null;
  limit?: number;
};

export type SuggestResult = {
  items: SqlSuggestion[];
  /** Replace [from, to) with the accepted insert. `to` is always the caret. */
  from: number;
  to: number;
  /** The partial word under the caret ('' when the caret follows whitespace). */
  word: string;
  /** Inline preview drawn after the caret for the top item. */
  ghost: string;
};

const EMPTY: SuggestResult = { items: [], from: 0, to: 0, word: '', ghost: '' };

// ───────────────────────── suggestion builders ─────────────────────────

function kw(label: string, doc?: string): SqlSuggestion {
  return { label, insert: label, kind: 'keyword', detail: 'keyword', doc };
}

function kws(labels: string[]): SqlSuggestion[] {
  return labels.map(l => kw(l));
}

function snip(label: string, insert: string, doc?: string, cursorOffset = 0): SqlSuggestion {
  return { label, insert, kind: 'snippet', detail: 'snippet', doc, cursorOffset };
}

function ph(name: string, doc?: string): SqlSuggestion {
  return { label: name, insert: name, kind: 'placeholder', detail: 'name', doc, selectInserted: true };
}

// ───────────────────────── lexical helpers ─────────────────────────

/**
 * Walk the text tracking strings / comments so we can find the `;` that
 * starts the statement the caret is in, and the one that ends it.
 */
function statementRange(text: string, cursor: number): { start: number; end: number } {
  let start = 0;
  let i = 0;
  let end = text.length;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '-' && c2 === '-') { const nl = text.indexOf('\n', i); i = nl === -1 ? n : nl; continue; }
    if (c === '/' && c2 === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === ';') {
      if (i < cursor) start = i + 1;
      else { end = i; break; }
    }
    i++;
  }
  return { start, end };
}

/** Strip comments and string bodies, collapse whitespace, upper-case. */
function normalize(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') { const nl = sql.indexOf('\n', i); i = nl === -1 ? n : nl; out += ' '; continue; }
    if (c === '/' && c2 === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; out += ' '; continue; }
    if (c === "'") {
      i++;
      while (i < n) { if (sql[i] === '\\') { i += 2; continue; } if (sql[i] === "'") { i++; break; } i++; }
      out += "'x'";
      continue;
    }
    if (c === '"' || c === '`') {
      const q = c; i++;
      let id = '';
      while (i < n) { if (sql[i] === q) { i++; break; } id += sql[i]; i++; }
      out += id.replace(/\s+/g, '_');
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Net unclosed `(` in the statement head — tells us we're inside a list. */
function openParens(head: string): number {
  let depth = 0;
  for (const c of head) {
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

// ───────────────────────── schema lookups ─────────────────────────

type ScopeTable = { schema: string; name: string; columns: { name: string; type: string }[] };

type Scope = {
  /** table name (lower-case) → columns, across every schema. */
  tables: Map<string, ScopeTable>;
  /** tables referenced in this statement, plus their aliases. */
  refs: { table: string; alias?: string }[];
};

function buildScope(schema: DbSchema[] | null | undefined, stmt: string): Scope {
  const tables = new Map<string, ScopeTable>();
  for (const s of schema || []) {
    for (const t of s.tables) {
      const key = t.name.toLowerCase();
      if (!tables.has(key)) {
        tables.set(key, { schema: s.name, name: t.name, columns: t.columns.map(c => ({ name: c.name, type: c.type })) });
      }
    }
  }
  const refs: { table: string; alias?: string }[] = [];
  const re = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+([A-Za-z_][\w$]*)(?:\.([A-Za-z_][\w$]*))?(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stmt))) {
    const table = (m[2] || m[1]).toLowerCase();
    let alias: string | undefined = m[3] ? m[3].toLowerCase() : undefined;
    // Don't mistake a following keyword for an alias.
    if (alias && RESERVED_AFTER_TABLE.has(alias.toUpperCase())) alias = undefined;
    refs.push({ table, alias });
  }
  return { tables, refs };
}

const RESERVED_AFTER_TABLE = new Set([
  'WHERE', 'SET', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'ON', 'GROUP', 'ORDER',
  'LIMIT', 'OFFSET', 'HAVING', 'UNION', 'VALUES', 'SELECT', 'RETURNING', 'USING', 'ADD',
  'DROP', 'RENAME', 'ALTER', 'MODIFY', 'CHANGE', 'IF', 'AS', 'OWNER', 'WITH'
]);

function tableItems(scope: Scope): SqlSuggestion[] {
  const out: SqlSuggestion[] = [];
  for (const t of scope.tables.values()) {
    out.push({ label: t.name, insert: t.name, kind: 'table', detail: `table · ${t.schema}`, doc: `${t.columns.length} columns` });
  }
  return out;
}

function columnItems(scope: Scope): SqlSuggestion[] {
  const out: SqlSuggestion[] = [];
  const seen = new Set<string>();
  const list: ScopeTable[] = [];
  for (const r of scope.refs) {
    const t = scope.tables.get(r.table);
    if (t && !list.includes(t)) list.push(t);
  }
  for (const t of list) {
    for (const c of t.columns) {
      if (seen.has(c.name.toLowerCase())) continue;
      seen.add(c.name.toLowerCase());
      out.push({ label: c.name, insert: c.name, kind: 'column', detail: `${c.type} · ${t.name}` });
    }
  }
  return out;
}

function columnsOf(scope: Scope, qualifier: string): SqlSuggestion[] {
  const q = qualifier.toLowerCase();
  const ref = scope.refs.find(r => r.alias === q || r.table === q);
  const t = scope.tables.get(ref ? ref.table : q);
  if (!t) return [];
  return t.columns.map(c => ({ label: c.name, insert: c.name, kind: 'column' as const, detail: `${c.type} · ${t.name}` }));
}

function tablesOfSchema(schema: DbSchema[] | null | undefined, name: string): SqlSuggestion[] {
  const s = (schema || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!s) return [];
  return s.tables.map(t => ({ label: t.name, insert: t.name, kind: 'table' as const, detail: `${t.type} · ${s.name}` }));
}

// ───────────────────────── static vocabularies ─────────────────────────

const STATEMENT_STARTERS = (driver: SqlDriver): SqlSuggestion[] => [
  snip('SELECT', 'SELECT * FROM ', 'Read rows from a table'),
  kw('INSERT INTO', 'Add new rows'),
  kw('UPDATE', 'Change existing rows'),
  kw('DELETE FROM', 'Remove rows'),
  kw('CREATE', 'Create a database, table, index, view, user…'),
  kw('ALTER', 'Change an existing object'),
  kw('DROP', 'Remove an object'),
  kw('TRUNCATE TABLE', 'Empty a table, keep its structure'),
  kw('WITH', 'Common table expression (CTE)'),
  kw('EXPLAIN', 'Show the query plan'),
  kw('GRANT', 'Give privileges to a user/role'),
  kw('REVOKE', 'Take privileges away'),
  ...(driver === 'mysql'
    ? [kw('SHOW', 'SHOW DATABASES / TABLES / CREATE TABLE …'), kw('DESCRIBE', 'Column layout of a table'), kw('USE', 'Switch the active database')]
    : [kw('ANALYZE', 'Refresh planner statistics'), kw('VACUUM', 'Reclaim storage'), kw('COMMENT ON', 'Attach a comment to an object')]),
  kw('BEGIN', 'Start a transaction'),
  kw('COMMIT', 'Commit the transaction'),
  kw('ROLLBACK', 'Undo the transaction'),
  snip('SELECT count(*)', 'SELECT count(*) FROM ', 'Row count'),
];

const CREATE_OBJECTS = (driver: SqlDriver): SqlSuggestion[] => [
  kw('DATABASE', 'A new database'),
  kw('TABLE', 'A new table'),
  kw('INDEX', 'Speed up lookups on one or more columns'),
  kw('UNIQUE INDEX', 'Index that also enforces uniqueness'),
  kw('VIEW', 'A saved query that behaves like a table'),
  kw('SCHEMA', 'A namespace for tables'),
  kw('USER', 'A login account'),
  ...(driver === 'postgres'
    ? [kw('ROLE', 'A user or group'), kw('MATERIALIZED VIEW', 'View stored on disk'), kw('SEQUENCE', 'Number generator'), kw('EXTENSION', 'Install a Postgres extension'), kw('TEMP TABLE', 'Session-scoped table')]
    : [kw('TEMPORARY TABLE', 'Session-scoped table'), kw('TRIGGER', 'Run SQL on insert/update/delete'), kw('PROCEDURE', 'Stored procedure')]),
];

const COLUMN_TYPES = (driver: SqlDriver): SqlSuggestion[] => (
  driver === 'postgres'
    ? [
      kw('serial PRIMARY KEY', 'Auto-incrementing integer key'),
      kw('bigserial PRIMARY KEY', 'Auto-incrementing 64-bit key'),
      kw('integer'), kw('bigint'), kw('smallint'), kw('numeric(12,2)'), kw('double precision'),
      kw('text'), kw('varchar(255)'), kw('boolean'), kw('date'),
      kw('timestamptz DEFAULT now()', 'Timestamp with time zone'), kw('timestamp'), kw('uuid'), kw('jsonb'),
    ]
    : [
      kw('INT AUTO_INCREMENT PRIMARY KEY', 'Auto-incrementing integer key'),
      kw('BIGINT'), kw('INT'), kw('SMALLINT'), kw('DECIMAL(12,2)'), kw('DOUBLE'),
      kw('TEXT'), kw('VARCHAR(255)'), kw('BOOLEAN'), kw('DATE'),
      kw('DATETIME DEFAULT CURRENT_TIMESTAMP'), kw('TIMESTAMP'), kw('CHAR(36)'), kw('JSON'),
    ]
);

const COLUMN_CONSTRAINTS: SqlSuggestion[] = [
  kw('NOT NULL', 'Reject NULL values'),
  kw('PRIMARY KEY', 'Row identity'),
  kw('UNIQUE', 'No duplicates'),
  kw('DEFAULT', 'Value used when none is given'),
  kw('REFERENCES', 'Foreign key to another table'),
  kw('CHECK', 'Validation expression'),
];

const FUNCTIONS: SqlSuggestion[] = [
  { label: 'count(*)', insert: 'count(*)', kind: 'function', detail: 'aggregate', doc: 'Number of rows' },
  { label: 'sum()', insert: 'sum()', kind: 'function', detail: 'aggregate', cursorOffset: -1 },
  { label: 'avg()', insert: 'avg()', kind: 'function', detail: 'aggregate', cursorOffset: -1 },
  { label: 'min()', insert: 'min()', kind: 'function', detail: 'aggregate', cursorOffset: -1 },
  { label: 'max()', insert: 'max()', kind: 'function', detail: 'aggregate', cursorOffset: -1 },
  { label: 'coalesce()', insert: 'coalesce()', kind: 'function', detail: 'function', doc: 'First non-NULL argument', cursorOffset: -1 },
  { label: 'now()', insert: 'now()', kind: 'function', detail: 'function', doc: 'Current timestamp' },
  { label: 'lower()', insert: 'lower()', kind: 'function', detail: 'function', cursorOffset: -1 },
  { label: 'upper()', insert: 'upper()', kind: 'function', detail: 'function', cursorOffset: -1 },
];

const AFTER_TABLE_REF: SqlSuggestion[] = [
  kw('WHERE', 'Filter rows'),
  kw('ORDER BY', 'Sort the result'),
  kw('GROUP BY', 'Collapse rows into groups'),
  kw('LIMIT', 'Cap the number of rows'),
  kw('JOIN', 'Combine with another table'),
  kw('LEFT JOIN', 'Keep unmatched left rows'),
  kw('INNER JOIN', 'Only matching rows'),
  kw('AS', 'Give the table an alias'),
  kw(';', 'End the statement'),
];

const AFTER_PREDICATE: SqlSuggestion[] = [
  kw('AND', 'Both conditions must hold'),
  kw('OR', 'Either condition may hold'),
  kw('ORDER BY'), kw('GROUP BY'), kw('LIMIT'),
  kw('IS NULL'), kw('IS NOT NULL'), kw('LIKE'), kw('IN ('), kw('BETWEEN'),
  kw(';'),
];

// ───────────────────────── the rule table ─────────────────────────

type RuleArgs = { driver: SqlDriver; schema?: DbSchema[] | null; scope: Scope; ctx: string };
type Rule = { re: RegExp; items: (a: RuleArgs) => SqlSuggestion[] };

// Ordered most-specific → most-general; the first match wins.
const RULES: Rule[] = [
  // ── CREATE DATABASE ────────────────────────────────────────────────
  {
    re: /\bCREATE\s+DATABASE(\s+IF\s+NOT\s+EXISTS)?$/,
    items: ({ driver, ctx }) => [
      ph('database_name', 'Name of the new database'),
      ...(driver === 'mysql' && !/IF\s+NOT\s+EXISTS$/.test(ctx) ? [kw('IF NOT EXISTS', 'Skip silently when it already exists')] : []),
    ],
  },
  {
    re: /\bCREATE\s+DATABASE\s+(IF\s+NOT\s+EXISTS\s+)?[\w."]+(\s+WITH)?$/,
    items: ({ driver }) => (driver === 'postgres'
      ? [
        snip('OWNER', 'OWNER ', 'Role that will own the database'),
        kw('WITH', 'Introduces the option list'),
        snip('TEMPLATE template0', 'TEMPLATE template0', 'Database to clone from'),
        snip("ENCODING 'UTF8'", "ENCODING 'UTF8'", 'Character encoding'),
        snip("LC_COLLATE 'en_US.UTF-8'", "LC_COLLATE 'en_US.UTF-8'", 'Sort order'),
        snip("LC_CTYPE 'en_US.UTF-8'", "LC_CTYPE 'en_US.UTF-8'", 'Character classification'),
        kw('TABLESPACE', 'Where the files live'),
        snip('CONNECTION LIMIT -1', 'CONNECTION LIMIT -1', 'Max concurrent connections (-1 = unlimited)'),
        kw(';', 'Done — run it'),
      ]
      : [
        snip('CHARACTER SET utf8mb4', 'CHARACTER SET utf8mb4', 'Default charset for new tables'),
        snip('COLLATE utf8mb4_unicode_ci', 'COLLATE utf8mb4_unicode_ci', 'Default collation'),
        snip('DEFAULT CHARACTER SET utf8mb4', 'DEFAULT CHARACTER SET utf8mb4', 'Default charset for new tables'),
        kw(';', 'Done — run it'),
      ]),
  },
  {
    re: /\bOWNER(\s+TO)?$/,
    items: ({ driver }) => [
      ph('owner_name', 'Existing role that becomes the owner'),
      ...(driver === 'postgres' ? [kw('CURRENT_USER', 'The role you are connected as'), kw('postgres', 'The default superuser')] : []),
    ],
  },
  {
    re: /\bCREATE\s+DATABASE\s+(IF\s+NOT\s+EXISTS\s+)?[\w."]+\s+(WITH\s+)?OWNER\s+[\w"]+$/,
    items: ({ driver }) => (driver === 'postgres'
      ? [snip("ENCODING 'UTF8'", "ENCODING 'UTF8'"), snip('TEMPLATE template0', 'TEMPLATE template0'), snip('CONNECTION LIMIT -1', 'CONNECTION LIMIT -1'), kw(';')]
      : [kw(';')]),
  },

  // ── CREATE TABLE / VIEW / INDEX / USER ─────────────────────────────
  {
    re: /\bCREATE\s+(TEMP(ORARY)?\s+)?TABLE(\s+IF\s+NOT\s+EXISTS)?$/,
    items: ({ ctx }) => [
      ph('table_name', 'Name of the new table'),
      ...(!/IF\s+NOT\s+EXISTS$/.test(ctx) ? [kw('IF NOT EXISTS')] : []),
    ],
  },
  {
    re: /\bCREATE\s+(TEMP(ORARY)?\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?[\w."]+$/,
    items: ({ driver }) => [
      driver === 'postgres'
        ? snip('( … column list … )', '(\n  id serial PRIMARY KEY,\n  name text NOT NULL,\n  created_at timestamptz NOT NULL DEFAULT now()\n)', 'Column definitions', -1)
        : snip('( … column list … )', '(\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP\n)', 'Column definitions', -1),
      snip('AS SELECT', 'AS SELECT ', 'Create the table from a query'),
      snip('LIKE', 'LIKE ', 'Copy another table’s structure'),
    ],
  },
  {
    re: /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+[\w."]+$/,
    items: () => [snip('AS SELECT', 'AS SELECT * FROM ', 'The query this view stands for')],
  },
  {
    re: /\bCREATE\s+(UNIQUE\s+)?INDEX(\s+CONCURRENTLY)?(\s+IF\s+NOT\s+EXISTS)?$/,
    items: ({ driver }) => [
      ph('index_name', 'Name of the new index'),
      ...(driver === 'postgres' ? [kw('CONCURRENTLY', 'Build without locking writes'), kw('IF NOT EXISTS')] : []),
    ],
  },
  {
    re: /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?[\w."]+$/,
    items: () => [snip('ON', 'ON ', 'Table the index covers')],
  },
  {
    re: /\bCREATE\s+(USER|ROLE)$/,
    items: () => [ph('user_name', 'Name of the new account')],
  },
  {
    re: /\bCREATE\s+(USER|ROLE)\s+[\w."'@%]+$/,
    items: ({ driver }) => (driver === 'postgres'
      ? [snip("WITH PASSWORD ''", "WITH PASSWORD ''", 'Set the login password', -1), kw('LOGIN'), kw('SUPERUSER'), kw('CREATEDB'), kw('NOLOGIN'), kw(';')]
      : [snip("IDENTIFIED BY ''", "IDENTIFIED BY ''", 'Set the login password', -1), kw(';')]),
  },
  {
    re: /\bCREATE\s+(SCHEMA|EXTENSION|SEQUENCE)$/,
    items: () => [ph('name'), kw('IF NOT EXISTS')],
  },
  {
    re: /\bCREATE(\s+OR\s+REPLACE)?$/,
    items: ({ driver }) => CREATE_OBJECTS(driver),
  },

  // ── ALTER ──────────────────────────────────────────────────────────
  {
    re: /\bALTER\s+TABLE\s+[\w."]+$/,
    items: ({ driver }) => [
      snip('ADD COLUMN', 'ADD COLUMN ', 'Append a new column'),
      snip('DROP COLUMN', 'DROP COLUMN ', 'Remove a column'),
      snip('RENAME COLUMN', 'RENAME COLUMN ', 'Rename a column'),
      snip('RENAME TO', 'RENAME TO ', 'Rename the table'),
      snip('ADD CONSTRAINT', 'ADD CONSTRAINT ', 'Add a key or check'),
      ...(driver === 'postgres'
        ? [snip('ALTER COLUMN', 'ALTER COLUMN ', 'Change a column’s type/default'), snip('OWNER TO', 'OWNER TO ', 'Hand the table to another role')]
        : [snip('MODIFY COLUMN', 'MODIFY COLUMN ', 'Change a column’s type'), snip('CHANGE COLUMN', 'CHANGE COLUMN ', 'Rename + retype a column'), snip('ADD INDEX', 'ADD INDEX ', 'Index one or more columns')]),
    ],
  },
  {
    re: /\bALTER\s+DATABASE\s+[\w."]+$/,
    items: ({ driver }) => (driver === 'postgres'
      ? [snip('OWNER TO', 'OWNER TO ', 'Change the owning role'), snip('RENAME TO', 'RENAME TO '), snip('SET', 'SET ', 'Set a per-database parameter'), kw('CONNECTION LIMIT')]
      : [snip('CHARACTER SET utf8mb4', 'CHARACTER SET utf8mb4'), snip('COLLATE utf8mb4_unicode_ci', 'COLLATE utf8mb4_unicode_ci')]),
  },
  {
    re: /\bALTER$/,
    items: ({ driver }) => [
      kw('TABLE'), kw('DATABASE'), kw('INDEX'), kw('VIEW'), kw('SCHEMA'),
      ...(driver === 'postgres' ? [kw('ROLE'), kw('SEQUENCE'), kw('USER')] : [kw('USER')]),
    ],
  },

  // ── DROP / TRUNCATE ────────────────────────────────────────────────
  {
    re: /\bDROP\s+(TABLE|DATABASE|INDEX|VIEW|SCHEMA|USER|ROLE)(\s+IF\s+EXISTS)?$/,
    items: ({ scope, ctx }) => [
      ...(/DROP\s+TABLE/.test(ctx) ? tableItems(scope) : [ph('name')]),
      ...(!/IF\s+EXISTS$/.test(ctx) ? [kw('IF EXISTS', 'Do nothing if it isn’t there')] : []),
    ],
  },
  {
    re: /\bDROP$/,
    items: () => [kw('TABLE'), kw('DATABASE'), kw('INDEX'), kw('VIEW'), kw('SCHEMA'), kw('USER'), kw('IF EXISTS')],
  },

  // ── INSERT / UPDATE / DELETE ───────────────────────────────────────
  { re: /\bINSERT$/, items: () => [kw('INTO')] },
  {
    re: /\bINSERT\s+INTO\s+([\w."]+)$/,
    items: ({ scope, ctx }) => {
      const m = /\bINSERT\s+INTO\s+([\w."]+)$/.exec(ctx);
      const name = (m?.[1] || '').split('.').pop()!.toLowerCase();
      const t = scope.tables.get(name);
      const out: SqlSuggestion[] = [];
      if (t) {
        const cols = t.columns.filter(c => !/^id$/i.test(c.name)).map(c => c.name);
        if (cols.length > 0) {
          const placeholders = cols.map(() => '?').join(', ');
          out.push(snip(`(${cols.slice(0, 4).join(', ')}${cols.length > 4 ? ', …' : ''}) VALUES (…)`,
            `(${cols.join(', ')})\nVALUES (${placeholders})`,
            `All ${cols.length} columns of ${t.name}`));
        }
      }
      out.push(snip('(columns) VALUES (…)', '() VALUES ()', 'Column list, then values', -13));
      out.push(kw('VALUES'), kw('SELECT', 'Insert the result of a query'), kw('SET', 'MySQL: column = value form'));
      return out;
    },
  },
  { re: /\bUPDATE\s+[\w."]+$/, items: () => [snip('SET', 'SET ', 'Columns to change')] },
  { re: /\bDELETE$/, items: () => [kw('FROM')] },
  {
    re: /\b(SET)$/,
    items: ({ scope }) => [...columnItems(scope), ph('column')],
  },

  // ── GRANT / REVOKE ─────────────────────────────────────────────────
  {
    re: /\b(GRANT|REVOKE)$/,
    items: () => [kw('ALL PRIVILEGES'), kw('SELECT'), kw('INSERT'), kw('UPDATE'), kw('DELETE'), kw('CONNECT'), kw('USAGE')],
  },
  { re: /\bGRANT\s+.+\s+ON$/, items: ({ scope }) => [...tableItems(scope), kw('DATABASE'), kw('SCHEMA'), kw('ALL TABLES IN SCHEMA')] },
  { re: /\b(TO|FROM)$/, items: ({ scope, ctx }) => (/\b(GRANT|REVOKE)\b/.test(ctx) ? [ph('user_name')] : tableItems(scope)) },

  // ── SELECT pipeline ────────────────────────────────────────────────
  {
    re: /\bSELECT(\s+DISTINCT)?$/,
    items: ({ scope, ctx }) => [
      kw('*', 'Every column'),
      ...(!/DISTINCT$/.test(ctx) ? [kw('DISTINCT', 'Drop duplicate rows')] : []),
      ...FUNCTIONS,
      ...columnItems(scope),
    ],
  },
  { re: /\b(FROM|JOIN|INTO|TRUNCATE\s+TABLE)$/, items: ({ scope }) => [...tableItems(scope), ph('table_name')] },
  {
    re: /\b(JOIN)\s+[\w."]+(\s+(AS\s+)?[\w]+)?$/,
    items: ({ scope }) => [snip('ON', 'ON ', 'Join condition'), kw('USING ('), ...columnItems(scope)],
  },
  {
    re: /\bORDER\s+BY\s+[\w."(),\s*]+$/,
    items: () => [kw('DESC', 'Highest first'), kw('ASC', 'Lowest first'), kw('LIMIT'), kw(',', 'Sort by another column'), kw(';')],
  },
  { re: /\bGROUP\s+BY\s+[\w."(),\s*]+$/, items: () => [kw('HAVING', 'Filter the groups'), kw('ORDER BY'), kw('LIMIT'), kw(';')] },
  { re: /\b(GROUP|ORDER)\s+BY$/, items: ({ scope }) => [...columnItems(scope), ph('column')] },
  { re: /\b(WHERE|AND|OR|ON|HAVING|NOT)$/, items: ({ scope }) => [...columnItems(scope), ...FUNCTIONS, kw('NOT'), kw('EXISTS (')] },
  { re: /\bLIMIT$/, items: () => [kw('10'), kw('100'), kw('1000')] },
  { re: /\bLIMIT\s+\d+$/, items: () => [kw('OFFSET'), kw(';')] },
  {
    re: /\b(WHERE|AND|OR|ON|HAVING)\s+[\w."]+$/,
    items: () => [kw('='), kw('!='), kw('>'), kw('<'), kw('>='), kw('<='), kw('LIKE'), kw('IN ('), kw('IS NULL'), kw('IS NOT NULL'), kw('BETWEEN')],
  },
  { re: /\b(WHERE|AND|OR|HAVING)\s+.+$/, items: () => AFTER_PREDICATE },
  { re: /\bFROM\s+[\w."]+(\s+(AS\s+)?[\w]+)?$/, items: () => AFTER_TABLE_REF },
  { re: /\bUPDATE\s+[\w."]+\s+SET\s+.+$/, items: () => [kw('WHERE', 'Never forget this one'), kw(','), kw(';')] },

  // ── misc ───────────────────────────────────────────────────────────
  {
    re: /\bWITH$/,
    items: () => [snip('cte AS ( … )', 'cte AS (\n  SELECT *\n  FROM \n)\nSELECT * FROM cte', 'Common table expression', -22), kw('RECURSIVE')],
  },
  { re: /\bEXPLAIN$/, items: ({ driver }) => (driver === 'postgres' ? [kw('ANALYZE', 'Actually run it and report real timings'), kw('VERBOSE'), kw('SELECT')] : [kw('ANALYZE'), kw('SELECT'), kw('FORMAT=JSON')]) },
  {
    re: /\bSHOW$/,
    items: () => [kw('DATABASES'), kw('TABLES'), kw('COLUMNS FROM'), kw('CREATE TABLE'), kw('INDEX FROM'), kw('PROCESSLIST'), kw('VARIABLES LIKE'), kw('STATUS')],
  },
  { re: /\b(USE|DESCRIBE|DESC)$/, items: ({ scope }) => [...tableItems(scope), ph('name')] },
];

// ───────────────────────── ranking ─────────────────────────

function score(label: string, word: string): number {
  if (!word) return 0;
  const l = label.toLowerCase();
  const w = word.toLowerCase();
  if (l.startsWith(w)) return 0;
  const idx = l.indexOf(w);
  if (idx >= 0) return 1 + idx / 100;
  // subsequence
  let i = 0;
  for (const c of l) { if (c === w[i]) i++; if (i === w.length) break; }
  return i === w.length ? 3 : -1;
}

/**
 * Match quality first, then the order the rule declared its items in. That
 * second half matters: with nothing typed yet the list *is* the ranking, and
 * every rule lists its clauses most-likely-first ("after a table reference you
 * probably want WHERE", not "you want `;` because it is the shortest label").
 */
function rank(items: SqlSuggestion[], word: string, limit: number): SqlSuggestion[] {
  const seen = new Set<string>();
  const scored: { s: SqlSuggestion; k: number }[] = [];
  items.forEach((it, i) => {
    const key = it.kind + ' ' + it.insert;
    if (seen.has(key)) return;
    seen.add(key);
    const sc = score(it.label, word);
    if (sc < 0) return;
    scored.push({ s: it, k: sc * 1000 + i });
  });
  scored.sort((a, b) => a.k - b.k);
  return scored.slice(0, limit).map(x => x.s);
}

/** Match the user's typing case: a lower-case prefix gets lower-case keywords. */
function applyCase(items: SqlSuggestion[], word: string): SqlSuggestion[] {
  if (!word || word !== word.toLowerCase() || !/[a-z]/.test(word)) return items;
  return items.map(it => (it.kind === 'keyword' || it.kind === 'snippet'
    ? { ...it, label: it.label.toLowerCase(), insert: it.insert.toLowerCase() }
    : it));
}

// ───────────────────────── entry point ─────────────────────────

export function suggest(input: SuggestInput): SuggestResult {
  const { text, cursor } = input;
  const driver: SqlDriver = input.driver || 'postgres';
  const limit = input.limit ?? 12;
  if (cursor < 0 || cursor > text.length) return EMPTY;

  const { start, end } = statementRange(text, cursor);
  const head = text.slice(start, cursor);
  const stmt = text.slice(start, Math.max(end, cursor));

  // Never hint inside a string literal or a comment.
  if (inLiteralOrComment(head)) return EMPTY;

  const scope = buildScope(input.schema, stmt);

  // Partial word under the caret.
  const wordMatch = /[A-Za-z_][\w$]*$/.exec(head);
  const word = wordMatch ? wordMatch[0] : '';
  const from = cursor - word.length;
  const before = head.slice(0, head.length - word.length);

  // `alias.` / `schema.` → members of that thing.
  const dot = /([A-Za-z_][\w$]*)\s*\.\s*$/.exec(before);
  if (dot) {
    const qualifier = dot[1];
    let items = columnsOf(scope, qualifier);
    if (items.length === 0) items = tablesOfSchema(input.schema, qualifier);
    const ranked = rank(items, word, limit);
    return { items: ranked, from, to: cursor, word, ghost: ghostFor(ranked[0], word) };
  }

  const ctx = normalize(before);

  // Inside a CREATE TABLE ( … ) body: types and constraints.
  if (openParens(head) > 0 && /\bCREATE\s+(TEMP\w*\s+)?TABLE\b/.test(ctx)) {
    const afterName = /[,(]\s*[A-Za-z_][\w$]*\s+[A-Za-z_][\w$]*[^,(]*$/.test(before);
    const raw = afterName
      ? [...COLUMN_CONSTRAINTS, kw(','), kw(')')]
      : [...COLUMN_TYPES(driver), ...COLUMN_CONSTRAINTS, ph('column_name'), kw('PRIMARY KEY ('), kw('FOREIGN KEY (')];
    const ranked = rank(applyCase(raw, word), word, limit);
    return { items: ranked, from, to: cursor, word, ghost: ghostFor(ranked[0], word) };
  }

  let raw: SqlSuggestion[] | null = null;
  if (ctx === '') {
    raw = STATEMENT_STARTERS(driver);
  } else {
    for (const rule of RULES) {
      if (rule.re.test(ctx)) { raw = rule.items({ driver, schema: input.schema, scope, ctx }); break; }
    }
  }
  if (!raw || raw.length === 0) {
    // Generic fallback: whatever identifiers are around plus common keywords.
    raw = [...columnItems(scope), ...tableItems(scope), ...kws(['SELECT', 'FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'LIMIT', 'JOIN', 'AND', 'OR', 'AS']), ...FUNCTIONS];
  }

  const ranked = rank(applyCase(raw, word), word, limit);
  return { items: ranked, from, to: cursor, word, ghost: ghostFor(ranked[0], word) };
}

function ghostFor(top: SqlSuggestion | undefined, word: string): string {
  if (!top) return '';
  const insert = top.insert;
  if (word) {
    if (!insert.toLowerCase().startsWith(word.toLowerCase())) return '';
    const rest = insert.slice(word.length);
    return firstLine(rest);
  }
  return firstLine(insert);
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl) + ' …';
}

/** True when the caret sits inside an unterminated string or comment. */
function inLiteralOrComment(head: string): boolean {
  let i = 0;
  const n = head.length;
  while (i < n) {
    const c = head[i];
    const c2 = head[i + 1];
    if (c === '-' && c2 === '-') { const nl = head.indexOf('\n', i); if (nl === -1) return true; i = nl; continue; }
    if (c === '/' && c2 === '*') { const e = head.indexOf('*/', i + 2); if (e === -1) return true; i = e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      let closed = false;
      while (i < n) {
        if (head[i] === '\\') { i += 2; continue; }
        if (head[i] === q) { closed = true; i++; break; }
        i++;
      }
      if (!closed) return true;
      continue;
    }
    i++;
  }
  return false;
}
