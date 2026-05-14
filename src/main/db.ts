import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import net from 'net';
import { spawn } from 'child_process';
// undici is the HTTP stack bundled with Node 22 / Electron 33. It isn't a
// package in node_modules, so bundlers (Rollup/Vite) can't resolve it at
// build time. We dynamic-require it only when needed for self-signed cert
// support; for the common path we use the global fetch.
type UndiciAgent = unknown;
let _undiciAgent: ((opts: any) => UndiciAgent) | null = null;
async function getUndiciAgent(): Promise<((opts: any) => UndiciAgent) | null> {
  if (_undiciAgent) return _undiciAgent;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = eval("require")('undici');
    _undiciAgent = (opts: any) => new undici.Agent(opts);
    return _undiciAgent;
  } catch { return null; }
}
import { IPC } from '@shared/ipc';
import type { DbConnectionProfile, DbResult, DbRowUpdate, DbUpdateResult, DbSchema, DbTable, DbColumn } from '@shared/types';
import { getStorageDir } from './storage.js';
import { onShutdown } from './lifecycle.js';
import { LIMITS } from './limits.js';

// Slice a result set down to LIMITS.dbResultRows and flag it as truncated so
// the UI can show "showing first N of M" rather than silently dropping rows.
function capRows<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  if (rows.length <= LIMITS.dbResultRows) return { rows, truncated: false };
  return { rows: rows.slice(0, LIMITS.dbResultRows), truncated: true };
}

// ────────── Elasticsearch / OpenSearch helpers ──────────
function esBaseUrl(profile: DbConnectionProfile, relayHost?: string, relayPort?: number): string {
  // Auto-detect protocol from host prefix; fall back to the ssl flag.
  let proto = profile.ssl ? 'https' : 'http';
  if (/^https:\/\//i.test(profile.host)) proto = 'https';
  else if (/^http:\/\//i.test(profile.host)) proto = 'http';
  const host = relayHost ?? profile.host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const port = relayPort ?? profile.port;
  return `${proto}://${host}:${port}`;
}

// A real-browser User-Agent. Undici's default is something like
// `node` which trips up some WAFs / corporate proxies / ES gateways that
// reject non-browser clients. Pretending to be Chrome on macOS is harmless
// here since we're only hitting your own ES clusters, and it gets us past
// the common "Forbidden" wall.
const MOZILLA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

async function esFetch(
  profile: DbConnectionProfile,
  password: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  relayHost?: string,
  relayPort?: number
): Promise<{ status: number; body: any }> {
  const url = esBaseUrl(profile, relayHost, relayPort) + (path.startsWith('/') ? path : '/' + path);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': MOZILLA_UA
  };
  if (profile.user) {
    const creds = Buffer.from(`${profile.user}:${password ?? ''}`).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  }
  // Allow self-signed certs when user opted in.
  const useHttps = url.startsWith('https://');
  let dispatcher: UndiciAgent | undefined;
  if (useHttps && profile.allowSelfSigned) {
    const make = await getUndiciAgent();
    if (make) dispatcher = make({ connect: { rejectUnauthorized: false } });
  }
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // @ts-expect-error undici dispatcher pass-through
      dispatcher
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, body: parsed };
  } catch (err: any) {
    // Node's fetch wraps the underlying socket/TLS error inside `cause`.
    const cause = err?.cause;
    const code = cause?.code as string | undefined;
    const detail = cause?.message || err?.message || String(err);
    let hint = '';
    if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      hint = ` — toggle "Accept self-signed certificates" in the connection settings.`;
    } else if (code === 'ECONNREFUSED') {
      hint = ` — nothing listening on ${url}. Wrong port? Server down?`;
    } else if (code === 'ENOTFOUND') {
      hint = ` — hostname not resolvable.`;
    } else if (code === 'EHOSTUNREACH') {
      hint = ` — LAN host not reachable; if on macOS, see the same network workaround as SQL connections.`;
    } else if (code === 'ECONNRESET') {
      hint = ` — connection reset. Maybe the server expects HTTPS but you connected over HTTP (toggle "Use HTTPS"), or there's a proxy in the way.`;
    } else if (/wrong version number|ssl/i.test(detail)) {
      hint = ` — TLS protocol mismatch; flip the "Use HTTPS" checkbox.`;
    }
    throw new Error(`${url} → ${detail}${code ? ` [${code}]` : ''}${hint}`);
  }
}

function esColumnsFromMapping(mapping: any): DbColumn[] {
  // Mapping shape: { index: { mappings: { properties: { field: { type, ... }, ... } } } }
  const idx = Object.keys(mapping || {})[0];
  const props = mapping?.[idx]?.mappings?.properties || {};
  const cols: DbColumn[] = [];
  const walk = (obj: any, prefix: string) => {
    for (const [k, v] of Object.entries(obj as Record<string, any>)) {
      const name = prefix ? `${prefix}.${k}` : k;
      if (v?.properties) {
        walk(v.properties, name);
      } else {
        cols.push({ name, type: v?.type || 'object', nullable: true });
      }
    }
  };
  walk(props, '');
  return cols;
}

type ProbeStep = { name: string; ok: boolean; detail: string };
type Relay = { host: string; port: number; cleanup: () => void };

function isLanHost(host: string): boolean {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
}

// Workaround for macOS Sequoia's Local Network filter on unsigned apps:
// the kernel drops unicast packets from our process to RFC1918 IPs, but it
// doesn't drop them from /usr/bin/nc (system-signed, its own TCC attribution).
// We bind a Node server on 127.0.0.1 (loopback is exempt) and for every
// inbound connection pipe stdio to a spawned `nc <host> <port>`. The DB
// driver then connects to 127.0.0.1:<port> transparently.
async function startNcRelay(host: string, port: number): Promise<Relay> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const localPort = (server.address() as net.AddressInfo).port;
  const procs = new Set<ReturnType<typeof spawn>>();
  server.on('connection', (sock) => {
    const proc = spawn('nc', [host, String(port)]);
    procs.add(proc);
    const cleanup = () => {
      procs.delete(proc);
      try { sock.destroy(); } catch {}
      try { proc.kill(); } catch {}
    };
    sock.on('error', cleanup);
    sock.on('close', cleanup);
    proc.on('error', cleanup);
    proc.on('exit', cleanup);
    sock.pipe(proc.stdin!);
    proc.stdout!.pipe(sock);
  });
  return {
    host: '127.0.0.1',
    port: localPort,
    cleanup: () => {
      for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
      try { server.close(); } catch {}
    }
  };
}

async function maybeStartRelay(host: string, port: number): Promise<Relay> {
  if (process.platform !== 'darwin' || !isLanHost(host)) {
    return { host, port, cleanup: () => {} };
  }
  return startNcRelay(host, port);
}

async function probeRawSocket(host: string, port: number, family?: 4 | 6, timeoutMs = 5000): Promise<ProbeStep> {
  const name = `node net.Socket${family ? ` (IPv${family})` : ''}`;
  return new Promise<ProbeStep>((resolve) => {
    const sock = new net.Socket();
    const start = Date.now();
    const finish = (ok: boolean, detail: string) => {
      try { sock.destroy(); } catch {}
      resolve({ name, ok, detail });
    };
    const t = setTimeout(() => finish(false, `timeout after ${timeoutMs}ms`), timeoutMs);
    sock.once('connect', () => { clearTimeout(t); finish(true, `connected in ${Date.now() - start}ms`); });
    sock.once('error', (err: NodeJS.ErrnoException) => { clearTimeout(t); finish(false, `${err.code || ''} ${err.message}`); });
    try {
      sock.connect({ host, port, family });
    } catch (e: any) {
      clearTimeout(t);
      finish(false, e?.message || String(e));
    }
  });
}

async function probeNc(host: string, port: number, timeoutMs = 5000): Promise<ProbeStep> {
  return new Promise<ProbeStep>((resolve) => {
    const proc = spawn('nc', ['-vz', '-G', '4', host, String(port)], { env: process.env });
    let out = '';
    proc.stdout.on('data', (b) => { out += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { out += b.toString('utf8'); });
    const t = setTimeout(() => { try { proc.kill(); } catch {}; resolve({ name: 'nc subprocess', ok: false, detail: `timeout: ${out.trim().slice(0, 200)}` }); }, timeoutMs);
    proc.on('error', (err) => { clearTimeout(t); resolve({ name: 'nc subprocess', ok: false, detail: `spawn failed: ${err.message}` }); });
    proc.on('close', (code) => {
      clearTimeout(t);
      const text = out.trim().slice(0, 200) || `exit ${code}`;
      resolve({ name: 'nc subprocess', ok: code === 0, detail: text });
    });
  });
}

async function runNetworkDiagnostic(host: string, port: number): Promise<ProbeStep[]> {
  return Promise.all([
    probeRawSocket(host, port, 4),
    probeRawSocket(host, port),
    probeNc(host, port)
  ]);
}

type Pool = { driver: 'mysql' | 'postgres' | 'elasticsearch'; client: any; profile: DbConnectionProfile; relay?: Relay };
const pools = new Map<string, Pool>();
// Runtime "current database" overrides per profile (don't persist) — lets
// the user click a different database in the tree without editing the saved
// profile. Pool keyed by profileId so we close+reopen on switch.
const dbOverrides = new Map<string, string>();
function effectiveDatabase(profile: DbConnectionProfile): string | undefined {
  const o = dbOverrides.get(profile.id);
  if (o !== undefined) return o;
  if (profile.database) return profile.database;
  return profile.driver === 'postgres' ? 'postgres' : undefined;
}

const KEYTAR_SERVICE = 'opendev-ide-db';

async function getKeytar(): Promise<typeof import('keytar') | null> {
  try { return (await import('keytar')).default ?? (await import('keytar')); } catch { return null; }
}

// Keychain access on an ad-hoc-signed macOS build can fail (the system
// prompts for permission, denies outright, or silently HANGS while the
// dialog is offscreen). We:
//   1. catch errors so the profile save never fails because of keytar
//   2. race the call against a 3s timeout so a hung dialog never blocks
//      the IPC handler from returning — the user would otherwise see
//      "Saving…" stuck on the button forever and think the modal froze.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}
async function setPassword(id: string, password: string) {
  try {
    const k = await getKeytar();
    if (k) await withTimeout(k.setPassword(KEYTAR_SERVICE, id, password), 3000, 'keychain setPassword');
  } catch (e: any) {
    console.error('[db.setPassword] keychain write failed:', e?.message || e);
  }
}
async function getPassword(id: string): Promise<string | undefined> {
  try {
    const k = await getKeytar();
    if (!k) return undefined;
    return (await withTimeout(k.getPassword(KEYTAR_SERVICE, id), 3000, 'keychain getPassword')) ?? undefined;
  } catch (e: any) {
    console.error('[db.getPassword] keychain read failed:', e?.message || e);
    return undefined;
  }
}
async function deletePassword(id: string) {
  try {
    const k = await getKeytar();
    if (k) await withTimeout(k.deletePassword(KEYTAR_SERVICE, id), 3000, 'keychain deletePassword');
  } catch (e: any) {
    console.error('[db.deletePassword] keychain delete failed:', e?.message || e);
  }
}

function profilesPath(): string { return join(getStorageDir(), 'db-connections.json'); }

async function readProfiles(): Promise<DbConnectionProfile[]> {
  try {
    const raw = await fs.readFile(profilesPath(), 'utf8');
    return (JSON.parse(raw) as { items: DbConnectionProfile[] }).items ?? [];
  } catch { return []; }
}

async function writeProfiles(items: DbConnectionProfile[]): Promise<void> {
  await fs.writeFile(profilesPath(), JSON.stringify({ items }, null, 2), 'utf8');
}

async function openPool(profile: DbConnectionProfile, passwordOverride?: string): Promise<Pool> {
  const existing = pools.get(profile.id);
  if (existing) return existing;
  const password = passwordOverride ?? await getPassword(profile.id);
  const bareHost = profile.host.replace(/^https?:\/\//, '');
  const relay = await maybeStartRelay(bareHost, profile.port);
  const db = effectiveDatabase(profile);
  if (profile.driver === 'elasticsearch') {
    // For ES we keep a thin "client" record — actual calls are stateless fetches.
    const pool: Pool = { driver: 'elasticsearch', client: { password, relayHost: relay.host, relayPort: relay.port }, profile, relay };
    pools.set(profile.id, pool);
    return pool;
  }
  if (profile.driver === 'mysql') {
    const mysql = await import('mysql2/promise');
    const client = await mysql.createPool({
      host: relay.host,
      port: relay.port,
      user: profile.user,
      password,
      database: db,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 10_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      multipleStatements: true,
      charset: 'utf8mb4',
      ...{ allowPublicKeyRetrieval: true }
    } as import('mysql2/promise').PoolOptions);
    const pool: Pool = { driver: 'mysql', client, profile, relay };
    pools.set(profile.id, pool);
    return pool;
  } else {
    const { Pool: PgPool } = await import('pg');
    const client = new PgPool({
      host: relay.host,
      port: relay.port,
      user: profile.user,
      password,
      database: db || 'postgres',
      max: 5,
      connectionTimeoutMillis: 10_000
    });
    const pool: Pool = { driver: 'postgres', client, profile, relay };
    pools.set(profile.id, pool);
    return pool;
  }
}

async function testProfile(profile: DbConnectionProfile & { password?: string }): Promise<{ ok: true; serverInfo?: string; viaRelay?: boolean } | { ok: false; error: string; hint?: string }> {
  const bareHost = profile.host.replace(/^https?:\/\//, '');
  const relay = await maybeStartRelay(bareHost, profile.port);
  const viaRelay = relay.host !== bareHost;
  try {
    if (profile.driver === 'elasticsearch') {
      const password = profile.password ?? await getPassword(profile.id);
      const r = await esFetch(profile, password, 'GET', '/', undefined, relay.host, relay.port);
      relay.cleanup();
      if (r.status >= 400) {
        return { ok: false, error: `HTTP ${r.status}: ${typeof r.body === 'string' ? r.body : JSON.stringify(r.body)}`,
          hint: r.status === 401 ? 'Auth failed — wrong user/password.' : undefined };
      }
      const v = r.body?.version?.number;
      const flavor = r.body?.version?.distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch';
      const name = r.body?.cluster_name ? ` · cluster ${r.body.cluster_name}` : '';
      return { ok: true, serverInfo: v ? `${flavor} ${v}${name}` : flavor, viaRelay };
    }
    if (profile.driver === 'mysql') {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection({
        host: relay.host,
        port: relay.port,
        user: profile.user,
        password: profile.password ?? await getPassword(profile.id),
        database: profile.database || undefined,
        connectTimeout: 10_000,
        ...{ allowPublicKeyRetrieval: true }
      } as import('mysql2/promise').ConnectionOptions);
      try {
        const [r] = await conn.query('SELECT VERSION() AS v');
        const v = (r as Array<{ v: string }>)?.[0]?.v;
        return { ok: true, serverInfo: v ? `MySQL ${v}` : undefined, viaRelay };
      } finally { await conn.end(); relay.cleanup(); }
    } else {
      const { Client } = await import('pg');
      const client = new Client({
        host: relay.host,
        port: relay.port,
        user: profile.user,
        password: profile.password ?? await getPassword(profile.id),
        database: profile.database || 'postgres',
        connectionTimeoutMillis: 10_000
      });
      await client.connect();
      try {
        const r = await client.query('SELECT version() AS v');
        const v = r.rows[0]?.v;
        return { ok: true, serverInfo: v, viaRelay };
      } finally { await client.end(); relay.cleanup(); }
    }
  } catch (err: any) {
    relay.cleanup();
    const msg = err?.message || String(err);
    const code = err?.code as string | undefined;
    let hint: string | undefined;
    const altPort = profile.driver === 'postgres' ? 3306 : 5432;
    const altDriver = profile.driver === 'postgres' ? 'MySQL' : 'Postgres';
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') {
      // Run a sub-diagnostic so the user knows exactly where the failure is.
      const probes = await runNetworkDiagnostic(profile.host, profile.port).catch(() => [] as ProbeStep[]);
      const probesText = probes.map(p => `   ${p.ok ? '✓' : '✗'} ${p.name} — ${p.detail}`).join('\n');
      const allNcOk = probes.find(p => p.name === 'nc subprocess')?.ok;
      const sockOk = probes.find(p => p.name.startsWith('node net.Socket (IPv4)'))?.ok;
      const isLan = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(profile.host);
      const lines: string[] = [];
      lines.push(`Network diagnostic for ${profile.host}:${profile.port} —`);
      lines.push(probesText);
      lines.push('');
      if (sockOk && !allNcOk) {
        lines.push(`Node sockets work but nc didn't — the IDE network stack is fine; the DB error is elsewhere.`);
      } else if (allNcOk && !sockOk) {
        lines.push(`nc reaches the host but Node sockets cannot. That's the classic macOS Local Network filter for unsigned apps on Sequoia.`);
        lines.push(`Workaround until we have a Developer ID: try launching the app from Terminal so it inherits Terminal's network permission:`);
        lines.push(`   open '/Applications/openDev.app'`);
        lines.push(`If that still fails:`);
        lines.push(`   tccutil reset LocalNetwork com.opendev.ide`);
        lines.push(`then relaunch. System Settings → Privacy & Security → Local Network should now list OpenDev IDE; turn it on.`);
      } else if (!allNcOk && !sockOk) {
        lines.push(`Neither nc nor Node sockets reach ${profile.host}:${profile.port}. This is a real network problem (VPN, VLAN, firewall) — not an IDE permission.`);
      } else if (isLan && process.platform === 'darwin') {
        lines.push(`Both probes succeeded but the DB driver still failed — try the test again; this is typically a transient first-attempt issue.`);
      }
      if (profile.driver === 'postgres') lines.push(`(If the DB is actually MySQL the right port is ${altPort}.)`);
      else if (profile.driver === 'mysql') lines.push(`(If the DB is actually Postgres the right port is ${altPort}.)`);
      hint = lines.join('\n');
    }
    else if (code === 'ECONNREFUSED') hint = `Host ${profile.host} answered but nothing is listening on port ${profile.port}. Is the server up? If it's ${altDriver}, port should be ${altPort}.`;
    else if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) hint = `Network timeout — the host is unreachable from here (firewall, VPN, bind-address?).`;
    else if (code === 'ENETUNREACH') hint = `Network unreachable — your machine has no route to ${profile.host}.`;
    else if (code === 'ENOTFOUND') hint = `Hostname couldn't be resolved.`;
    else if (/Access denied/i.test(msg)) hint = `Auth rejected. Check user, password, and host-grant — MySQL grants are user@host so '${profile.user}'@'%' may need an explicit grant for this IP.`;
    else if (/password authentication failed/i.test(msg)) hint = `Postgres password didn't match for user '${profile.user}'.`;
    else if (/no pg_hba.conf entry/i.test(msg)) hint = `Postgres pg_hba.conf doesn't allow connections from this client for that user.`;
    else if (/SSL\/TLS required/i.test(msg) || /SSL connection is required/i.test(msg)) hint = `Server requires SSL.`;
    else if (/database "[^"]+" does not exist/i.test(msg)) hint = `That database doesn't exist on this server — leave the Database field blank to list.`;
    return { ok: false, error: msg, hint };
  }
}

async function closePool(id: string): Promise<void> {
  const p = pools.get(id);
  if (!p) return;
  try {
    if (p.driver === 'mysql') await p.client.end();
    else if (p.driver === 'postgres') await p.client.end();
    // elasticsearch: nothing to close
  } catch {}
  try { p.relay?.cleanup(); } catch {}
  pools.delete(id);
}

async function fetchSchema(pool: Pool): Promise<DbSchema[]> {
  if (pool.driver === 'elasticsearch') {
    const r = await esFetch(pool.profile, pool.client.password, 'GET', '/_cat/indices?format=json&h=index,docs.count,store.size&s=index', undefined, pool.client.relayHost, pool.client.relayPort);
    if (r.status >= 400) throw new Error(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    const indices = (r.body as Array<{ index: string; 'docs.count'?: string }>).filter(i => i.index && !i.index.startsWith('.'));
    // Sample mapping per index, but only for the first 50 to keep things snappy.
    const tbls: DbTable[] = [];
    for (const idx of indices.slice(0, 100)) {
      let cols: DbColumn[] = [];
      try {
        const m = await esFetch(pool.profile, pool.client.password, 'GET', `/${encodeURIComponent(idx.index)}/_mapping`, undefined, pool.client.relayHost, pool.client.relayPort);
        if (m.status < 400) cols = esColumnsFromMapping(m.body);
      } catch {}
      tbls.push({ name: idx.index, type: 'table', columns: cols });
    }
    return [{ name: 'indices', tables: tbls }];
  }
  if (pool.driver === 'mysql') {
    // If the profile specified a database, prefer just that one — avoids
    // SHOW DATABASES which requires the SHOW DATABASES privilege.
    let dbNames: string[] = [];
    if (pool.profile.database) {
      dbNames = [pool.profile.database];
    } else {
      try {
        const [dbs] = await pool.client.query('SHOW DATABASES');
        dbNames = (dbs as Array<{ Database?: string; database?: string }>).map(r => (r.Database ?? r.database)!).filter(Boolean);
      } catch (err: any) {
        // Fall back to whatever the user has read access to via information_schema
        try {
          const [rows] = await pool.client.query(
            `SELECT DISTINCT table_schema AS s FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')`);
          dbNames = (rows as Array<{ s: string }>).map(r => r.s);
        } catch {
          throw new Error(`Couldn't list databases (${err?.code || ''}: ${err?.message || err}). Tip: set a specific database on the connection.`);
        }
      }
    }
    const schemas: DbSchema[] = [];
    for (const name of dbNames) {
      if (['information_schema', 'mysql', 'performance_schema', 'sys'].includes(name) && dbNames.length > 1) continue;
      let tables: any[] = [];
      try {
        const [t] = await pool.client.query(
          `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ?`, [name]);
        tables = t as any[];
      } catch {
        schemas.push({ name, tables: [] });
        continue;
      }
      const tbls: DbTable[] = [];
      for (const t of tables) {
        const tname = (t.table_name ?? t.TABLE_NAME)!;
        const ttype = ((t.table_type ?? t.TABLE_TYPE) === 'VIEW') ? 'view' : 'table';
        let cols: any[] = [];
        try {
          const [c] = await pool.client.query(
            `SELECT column_name, column_type, is_nullable, column_key
               FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
            [name, tname]);
          cols = c as any[];
        } catch { /* skip columns we can't read */ }
        const columns: DbColumn[] = cols.map(c => ({
          name: c.column_name ?? c.COLUMN_NAME,
          type: c.column_type ?? c.COLUMN_TYPE,
          nullable: (c.is_nullable ?? c.IS_NULLABLE) === 'YES',
          key: c.column_key ?? c.COLUMN_KEY
        }));
        tbls.push({ name: tname, type: ttype as 'table' | 'view', columns });
      }
      schemas.push({ name, tables: tbls });
    }
    return schemas;
  } else {
    const sres = await pool.client.query(
      `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname`);
    const schemas: DbSchema[] = [];
    for (const row of sres.rows as Array<{ nspname: string }>) {
      const tres = await pool.client.query(
        `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [row.nspname]);
      const tbls: DbTable[] = [];
      for (const t of tres.rows as Array<{ table_name: string; table_type: string }>) {
        const cres = await pool.client.query(
          `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
          [row.nspname, t.table_name]);
        const columns: DbColumn[] = cres.rows.map((c: any) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES'
        }));
        // Tag PK columns so the editable grid can build safe UPDATE
        // statements without us having to round-trip per table at edit time.
        try {
          const pkres = await pool.client.query(
            `SELECT kcu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema    = kcu.table_schema
              WHERE tc.constraint_type = 'PRIMARY KEY'
                AND tc.table_schema    = $1
                AND tc.table_name      = $2`,
            [row.nspname, t.table_name]);
          const pkSet = new Set((pkres.rows as Array<{ column_name: string }>).map(r => r.column_name));
          for (const c of columns) if (pkSet.has(c.name)) c.key = 'PRI';
        } catch { /* ignore — non-fatal */ }
        tbls.push({ name: t.table_name, type: t.table_type === 'VIEW' ? 'view' : 'table', columns });
      }
      schemas.push({ name: row.nspname, tables: tbls });
    }
    return schemas;
  }
}

async function runQuery(pool: Pool, sql: string): Promise<DbResult> {
  const start = Date.now();
  if (pool.driver === 'elasticsearch') {
    // The query text is either:
    //   - JSON DSL starting with `{` → POST to /<index>/_search
    //   - SQL → POST to /_sql?format=json
    const trimmed = sql.trim();
    if (trimmed.startsWith('{')) {
      // JSON DSL — first line can be: GET /index/_search\n{...}
      // Simplest: POST to /_search if not specified, else parse first line.
      const lines = sql.split('\n');
      const firstLine = lines[0].trim();
      let method = 'POST', path = '/_search';
      const dslMatch = firstLine.match(/^(GET|POST|PUT|DELETE)\s+(\/\S*)$/i);
      let bodyText = sql;
      if (dslMatch) {
        method = dslMatch[1].toUpperCase();
        path = dslMatch[2];
        bodyText = lines.slice(1).join('\n');
      }
      let body: unknown = undefined;
      try { body = bodyText.trim() ? JSON.parse(bodyText) : undefined; } catch (e: any) { throw new Error('Invalid JSON DSL: ' + e.message); }
      const r = await esFetch(pool.profile, pool.client.password, method, path, body, pool.client.relayHost, pool.client.relayPort);
      if (r.status >= 400) throw new Error(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      // Render hits as rows
      const hits = r.body?.hits?.hits as Array<{ _id: string; _source: any }> | undefined;
      if (hits) {
        const cols = new Set<string>(['_id']);
        for (const h of hits) for (const k of Object.keys(h._source || {})) cols.add(k);
        const columns = [...cols];
        const allRows = hits.map(h => columns.map(c => c === '_id' ? h._id : h._source?.[c]));
        const capped = capRows(allRows);
        return { columns, rows: capped.rows, rowCount: hits.length, durationMs: Date.now() - start, truncated: capped.truncated };
      }
      // Aggregations or other shapes — fall back to a single JSON cell.
      return { columns: ['response'], rows: [[r.body]], rowCount: 1, durationMs: Date.now() - start };
    }
    // SQL flavor — POST /_sql (works for both ES 7+ and OpenSearch _plugins/_sql is also tried as fallback)
    const trySql = async (path: string) => esFetch(pool.profile, pool.client.password, 'POST', path, { query: sql, fetch_size: 500 }, pool.client.relayHost, pool.client.relayPort);
    let r = await trySql('/_sql?format=json');
    if (r.status === 404) r = await trySql('/_plugins/_sql');
    if (r.status >= 400) throw new Error(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    const columns = ((r.body?.columns as Array<{ name: string }>) || []).map(c => c.name);
    const allRows = (r.body?.rows as unknown[][]) || (r.body?.datarows as unknown[][]) || [];
    const capped = capRows(allRows);
    return { columns, rows: capped.rows, rowCount: allRows.length, durationMs: Date.now() - start, truncated: capped.truncated };
  }
  if (pool.driver === 'mysql') {
    const [rows, fields] = await pool.client.query(sql);
    const columns = (fields as Array<{ name: string }> | undefined)?.map(f => f.name) ?? [];
    if (Array.isArray(rows)) {
      const totalCount = rows.length;
      const allMapped = (rows as Array<Record<string, unknown>>).map(r => columns.map(c => r[c]));
      const capped = capRows(allMapped);
      return {
        columns,
        rows: capped.rows,
        rowCount: totalCount,
        durationMs: Date.now() - start,
        truncated: capped.truncated
      };
    }
    return { columns: ['affectedRows'], rows: [[(rows as { affectedRows: number }).affectedRows]], rowCount: 1, durationMs: Date.now() - start };
  } else {
    const res = await pool.client.query(sql);
    const columns = res.fields.map((f: any) => f.name);
    const totalCount = res.rowCount ?? res.rows.length;
    const allMapped: unknown[][] = res.rows.map((r: any) => columns.map((c: string) => r[c]));
    const capped = capRows(allMapped);
    return {
      columns,
      rows: capped.rows,
      rowCount: totalCount,
      durationMs: Date.now() - start,
      truncated: capped.truncated
    };
  }
}

export function registerDbIpc() {
  ipcMain.handle(IPC.DbConnectionsList, () => readProfiles());
  ipcMain.handle(IPC.DbConnectionsSave, async (_e, profile: DbConnectionProfile & { password?: string }) => {
    try {
      const items = await readProfiles();
      const next: DbConnectionProfile = {
        id: profile.id || randomUUID(),
        name: profile.name,
        driver: profile.driver,
        host: profile.host,
        port: profile.port,
        user: profile.user,
        database: profile.database,
        readOnly: profile.readOnly,
        // Preserve ES-specific flags — dropping these on save was a bug:
        // editing an ES profile and clicking Save would silently revert
        // ssl=true / allowSelfSigned=true back to undefined.
        ssl: profile.ssl,
        allowSelfSigned: profile.allowSelfSigned
      };
      // setPassword catches its own keychain failures so it never throws
      // out here — those failures shouldn't block saving the profile.
      if (profile.password) await setPassword(next.id, profile.password);
      const idx = items.findIndex(i => i.id === next.id);
      if (idx >= 0) items[idx] = next; else items.push(next);
      await writeProfiles(items);
      console.log(`[db.save] persisted profile ${next.id} (${next.name})`);
      return next;
    } catch (e: any) {
      console.error('[db.save] failed:', e);
      throw e;
    }
  });
  ipcMain.handle(IPC.DbConnectionsDelete, async (_e, id: string) => {
    const items = (await readProfiles()).filter(i => i.id !== id);
    await writeProfiles(items);
    await deletePassword(id);
    await closePool(id);
    return true;
  });

  ipcMain.handle(IPC.DbConnect, async (_e, id: string) => {
    const items = await readProfiles();
    const profile = items.find(i => i.id === id);
    if (!profile) throw new Error('Profile not found');
    await openPool(profile);
    return true;
  });

  ipcMain.handle(IPC.DbTest, async (_e, profile: DbConnectionProfile & { password?: string }) => {
    return testProfile(profile);
  });

  ipcMain.handle(IPC.DbListDatabases, async (_e, id: string) => {
    const items = await readProfiles();
    const profile = items.find(i => i.id === id);
    if (!profile) throw new Error('Profile not found');
    const pool = await openPool(profile);
    if (pool.driver === 'elasticsearch') {
      // ES doesn't have multi-database; expose the cluster as one "database".
      const r = await esFetch(profile, pool.client.password, 'GET', '/', undefined, pool.client.relayHost, pool.client.relayPort);
      const cluster = r.body?.cluster_name || 'cluster';
      return { databases: [cluster], current: cluster };
    }
    if (pool.driver === 'mysql') {
      const [rows] = await pool.client.query('SHOW DATABASES');
      const names = (rows as Array<{ Database?: string; database?: string }>)
        .map(r => (r.Database ?? r.database)!)
        .filter(Boolean)
        .filter((n: string) => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(n));
      return { databases: names, current: effectiveDatabase(profile) };
    } else {
      const r = await pool.client.query(
        `SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname`);
      const names = r.rows.map((x: { datname: string }) => x.datname);
      return { databases: names, current: effectiveDatabase(profile) };
    }
  });

  ipcMain.handle(IPC.DbEsRequest, async (_e, id: string, payload: { method?: string; path?: string; body?: unknown }) => {
    const items = await readProfiles();
    const profile = items.find(i => i.id === id);
    if (!profile) throw new Error('Profile not found');
    if (profile.driver !== 'elasticsearch') throw new Error('Not an ES connection');
    const pool = await openPool(profile);
    const start = Date.now();
    const method = (payload.method || 'GET').toUpperCase();
    const path = payload.path || '/_search';
    const r = await esFetch(pool.profile, pool.client.password, method, path, payload.body, pool.client.relayHost, pool.client.relayPort);
    return { status: r.status, body: r.body, durationMs: Date.now() - start };
  });

  ipcMain.handle(IPC.DbSwitchDatabase, async (_e, id: string, dbName: string) => {
    dbOverrides.set(id, dbName);
    await closePool(id);
    const items = await readProfiles();
    const profile = items.find(i => i.id === id);
    if (!profile) throw new Error('Profile not found');
    await openPool(profile);
    return true;
  });

  ipcMain.handle(IPC.DbDisconnect, (_e, id: string) => closePool(id));

  ipcMain.handle(IPC.DbSchema, async (_e, id: string) => {
    const items = await readProfiles();
    const profile = items.find(i => i.id === id);
    if (!profile) throw new Error('Profile not found');
    const pool = await openPool(profile);
    return fetchSchema(pool);
  });

  ipcMain.handle(IPC.DbQuery, async (_e, id: string, sql: string) => {
    const items = await readProfiles();
    const profile = items.find(i => i.id === id);
    if (!profile) throw new Error('Profile not found');
    if (profile.readOnly && /^\s*(drop|delete|update|insert|truncate|alter)\b/i.test(sql)) {
      throw new Error('Connection is read-only');
    }
    const pool = await openPool(profile);
    return runQuery(pool, sql);
  });

  // Editable row grid → batched UPDATE. Each entry of `updates` becomes
  // one parameterized `UPDATE <table> SET <set> WHERE <where>` statement.
  // We run them inside a transaction so partial failures don't leave the
  // table in a half-saved state.
  ipcMain.handle(IPC.DbUpdateRows, async (_e, args: {
    connId: string;
    schema?: string;
    table: string;
    updates: DbRowUpdate[];
  }): Promise<DbUpdateResult> => {
    const items = await readProfiles();
    const profile = items.find(i => i.id === args.connId);
    if (!profile) throw new Error('Profile not found');
    if (profile.readOnly) throw new Error('Connection is read-only');
    if (profile.driver === 'elasticsearch') throw new Error('Row updates are only supported on SQL connections');
    const pool = await openPool(profile);
    const driver = pool.driver as 'mysql' | 'postgres';

    const errors: Array<{ index: number; message: string }> = [];
    let applied = 0;

    if (driver === 'mysql') {
      const conn = await pool.client.getConnection();
      try {
        await conn.beginTransaction();
        for (let i = 0; i < args.updates.length; i++) {
          const u = args.updates[i];
          if (!Object.keys(u.set).length || !Object.keys(u.where).length) {
            errors.push({ index: i, message: 'empty set or where' });
            continue;
          }
          const setKeys = Object.keys(u.set);
          const whereKeys = Object.keys(u.where);
          const setSql = setKeys.map(k => `\`${k.replace(/`/g, '``')}\` = ?`).join(', ');
          const whereSql = whereKeys.map(k => `\`${k.replace(/`/g, '``')}\` = ?`).join(' AND ');
          const ref = args.schema
            ? `\`${args.schema.replace(/`/g, '``')}\`.\`${args.table.replace(/`/g, '``')}\``
            : `\`${args.table.replace(/`/g, '``')}\``;
          const sql = `UPDATE ${ref} SET ${setSql} WHERE ${whereSql} LIMIT 1`;
          const params = [...setKeys.map(k => u.set[k]), ...whereKeys.map(k => u.where[k])];
          try {
            const [res] = await conn.query(sql, params);
            const affected = (res as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
            if (affected === 0) errors.push({ index: i, message: 'no row matched WHERE' });
            else applied++;
          } catch (e: any) {
            errors.push({ index: i, message: e?.message || String(e) });
          }
        }
        if (errors.length === args.updates.length) await conn.rollback();
        else await conn.commit();
      } finally {
        try { conn.release(); } catch {}
      }
    } else {
      // Postgres
      const client = pool.client;
      try {
        await client.query('BEGIN');
        for (let i = 0; i < args.updates.length; i++) {
          const u = args.updates[i];
          if (!Object.keys(u.set).length || !Object.keys(u.where).length) {
            errors.push({ index: i, message: 'empty set or where' });
            continue;
          }
          const setKeys = Object.keys(u.set);
          const whereKeys = Object.keys(u.where);
          const params: unknown[] = [];
          const setSql = setKeys.map(k => {
            params.push(u.set[k]);
            return `"${k.replace(/"/g, '""')}" = $${params.length}`;
          }).join(', ');
          const whereSql = whereKeys.map(k => {
            params.push(u.where[k]);
            return `"${k.replace(/"/g, '""')}" = $${params.length}`;
          }).join(' AND ');
          const ref = args.schema
            ? `"${args.schema.replace(/"/g, '""')}"."${args.table.replace(/"/g, '""')}"`
            : `"${args.table.replace(/"/g, '""')}"`;
          const sql = `UPDATE ${ref} SET ${setSql} WHERE ${whereSql}`;
          try {
            const res = await client.query(sql, params);
            if ((res.rowCount ?? 0) === 0) errors.push({ index: i, message: 'no row matched WHERE' });
            else applied++;
          } catch (e: any) {
            errors.push({ index: i, message: e?.message || String(e) });
          }
        }
        if (errors.length === args.updates.length) await client.query('ROLLBACK');
        else await client.query('COMMIT');
      } catch (e: any) {
        try { await client.query('ROLLBACK'); } catch {}
        throw e;
      }
    }

    return { applied, errors };
  });
}

onShutdown(async () => {
  for (const id of [...pools.keys()]) await closePool(id);
});
