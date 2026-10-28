// Импорт серверов из ~/.ssh/config и из сессий PuTTY (реестр Windows).
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ImportSummary, Server } from '../shared/types';
import { importKeyFromPath } from './keys';
import { newId, type Store } from './store';

const PALETTE = ['#3DDC97', '#4EA8FF', '#B48CFF', '#FF7AA2', '#FFB454', '#FF5C5C', '#5CE1E6', '#C7D0DA'];

function baseServer(): Server {
  return {
    id: newId(),
    name: '',
    hostname: '',
    port: 22,
    username: 'root',
    auth: 'password',
    keyID: null,
    startupSnippetID: null,
    colorHex: PALETTE[0],
    lastConnected: null,
    useTmux: false,
    autoReconnect: true,
    keepAlive: true,
    jumpHostID: null,
    proxy: null,
    forwards: [],
  };
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function sameTarget(a: Server, host: string, port: number, user: string): boolean {
  return a.hostname.toLowerCase() === host.toLowerCase() && a.port === port && a.username === user;
}

// ---------- ~/.ssh/config ----------

interface SshConfigHost {
  alias: string;
  options: Map<string, string[]>;
}

async function readConfigFile(file: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^include\s+(.+)$/i);
    if (!m) {
      out.push(rawLine);
      continue;
    }
    for (const pattern of m[1].split(/\s+/)) {
      let p = expandHome(pattern.replace(/^"|"$/g, ''));
      if (!path.isAbsolute(p)) p = path.join(os.homedir(), '.ssh', p);
      if (p.includes('*')) {
        const dir = path.dirname(p);
        const re = new RegExp('^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        let names: string[] = [];
        try { names = (await fsp.readdir(dir)).filter((n) => re.test(n)).sort(); } catch { /* ignore */ }
        for (const n of names) out.push(...(await readConfigFile(path.join(dir, n), depth + 1)));
      } else {
        out.push(...(await readConfigFile(p, depth + 1)));
      }
    }
  }
  return out;
}

export function parseSshConfig(lines: string[]): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: SshConfigHost[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'host') {
      current = value.split(/\s+/)
        .filter((a) => a && !/[*?!]/.test(a))
        .map((alias) => ({ alias, options: new Map<string, string[]>() }));
      hosts.push(...current);
      continue;
    }
    if (key === 'match') {
      current = [];
      continue;
    }
    for (const h of current) {
      // Первое значение побеждает (как в OpenSSH), кроме IdentityFile — их может быть несколько.
      const vals = h.options.get(key);
      if (!vals) h.options.set(key, [value.replace(/^"|"$/g, '')]);
      else if (key === 'identityfile') vals.push(value.replace(/^"|"$/g, ''));
    }
  }
  return hosts;
}

export async function importSshConfig(store: Store): Promise<ImportSummary> {
  const file = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(file)) {
    return { lines: ['Файл ~/.ssh/config не найден.'], warnings: [] };
  }
  const entries = parseSshConfig(await readConfigFile(file));
  const lines: string[] = [];
  const warnings: string[] = [];
  const existing = store.data().hosts;
  const byAlias = new Map<string, Server>();
  const pendingJumps: { server: Server; jump: string }[] = [];
  let added = 0, skipped = 0, keysImported = 0;

  for (const [i, e] of entries.entries()) {
    const get = (k: string) => e.options.get(k)?.[0];
    const hostname = get('hostname') ?? e.alias;
    const port = Number(get('port') ?? 22) || 22;
    const user = get('user') ?? os.userInfo().username ?? 'root';
    const dup = existing.find((s) => sameTarget(s, hostname, port, user));
    if (dup) {
      byAlias.set(e.alias, dup);
      skipped++;
      continue;
    }
    const server: Server = {
      ...baseServer(),
      name: e.alias,
      hostname,
      port,
      username: user,
      colorHex: PALETTE[(added + i) % PALETTE.length],
    };
    for (const identity of e.options.get('identityfile') ?? []) {
      const keyPath = expandHome(identity.replace(/%d/g, os.homedir()).replace(/%u/g, os.userInfo().username));
      if (!fs.existsSync(keyPath)) continue;
      try {
        const key = await importKeyFromPath(store, keyPath, path.basename(keyPath));
        server.auth = 'key';
        server.keyID = key.id;
        keysImported++;
        break;
      } catch (err) {
        warnings.push(`${e.alias}: ключ ${identity} не прочитан — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const jump = get('proxyjump');
    if (jump && jump.toLowerCase() !== 'none') pendingJumps.push({ server, jump: jump.split(',')[0].trim() });
    if (get('serveraliveinterval') === '0') server.keepAlive = false;
    byAlias.set(e.alias, server);
    store.saveServer(server);
    added++;
  }

  // ProxyJump: alias из этого же файла или user@host:port.
  for (const { server, jump } of pendingJumps) {
    let target = byAlias.get(jump);
    if (!target) {
      const m = jump.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
      if (m) {
        const host = m[2];
        const port = Number(m[3] ?? 22);
        const user = m[1] ?? os.userInfo().username;
        target = store.data().hosts.find((s) => sameTarget(s, host, port, user));
        if (!target) {
          target = { ...baseServer(), name: host, hostname: host, port, username: user };
          store.saveServer(target);
          added++;
        }
      }
    }
    if (target && target.id !== server.id) {
      store.saveServer({ ...server, jumpHostID: target.id });
    } else {
      warnings.push(`${server.name}: не найден промежуточный сервер «${jump}».`);
    }
  }

  lines.push(added ? `Добавлено серверов: ${added}` : 'Новых серверов нет.');
  if (keysImported) lines.push(`Подключено ключей: ${keysImported}`);
  if (skipped) lines.push(`Уже были в списке: ${skipped}`);
  return { lines, warnings };
}

// ---------- PuTTY ----------

interface PuttySession {
  Name: string;
  HostName?: string | null;
  PortNumber?: number | null;
  UserName?: string | null;
  Protocol?: string | null;
  PublicKeyFile?: string | null;
}

function runCapture(file: string, args: string[], encoding: BufferEncoding = 'utf8'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err && !stdout?.length) reject(err);
      else resolve((stdout as Buffer).toString(encoding));
    });
  });
}

async function readPuttySessions(): Promise<PuttySession[]> {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$root = 'HKCU:\\Software\\SimonTatham\\PuTTY\\Sessions'",
    "if (-not (Test-Path $root)) { '[]'; exit 0 }",
    "$list = @(Get-ChildItem $root | ForEach-Object {",
    "  $p = Get-ItemProperty $_.PSPath",
    "  [pscustomobject]@{ Name = $_.PSChildName; HostName = $p.HostName; PortNumber = $p.PortNumber; UserName = $p.UserName; Protocol = $p.Protocol; PublicKeyFile = $p.PublicKeyFile }",
    "})",
    "ConvertTo-Json -InputObject $list -Compress -Depth 3",
  ].join('\n');
  // -EncodedCommand (UTF-16LE base64) — не ломается на кавычках и не-ASCII.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await runCapture(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  const text = out.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as PuttySession | PuttySession[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function importPutty(store: Store): Promise<ImportSummary> {
  if (process.platform !== 'win32') throw new Error('Импорт из PuTTY доступен только в Windows.');
  let sessions: PuttySession[];
  try {
    sessions = await readPuttySessions();
  } catch (err) {
    throw new Error(`Не удалось прочитать сессии PuTTY: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lines: string[] = [];
  const warnings: string[] = [];
  let added = 0, skipped = 0, keys = 0, nonSsh = 0;
  const existing = store.data().hosts;

  for (const [i, s] of sessions.entries()) {
    const name = decodeURIComponent(String(s.Name ?? '').replace(/\+/g, ' '));
    const host = String(s.HostName ?? '').trim();
    if (!host || name === 'Default Settings') continue;
    const protocol = String(s.Protocol ?? 'ssh').toLowerCase();
    if (protocol !== 'ssh') {
      nonSsh++;
      continue;
    }
    // В PuTTY HostName может быть «user@host».
    let user = String(s.UserName ?? '').trim();
    let hostname = host;
    const at = host.lastIndexOf('@');
    if (at > 0) {
      if (!user) user = host.slice(0, at);
      hostname = host.slice(at + 1);
    }
    if (!user) user = 'root';
    const port = Number(s.PortNumber ?? 22) || 22;
    if (existing.some((e) => sameTarget(e, hostname, port, user))) {
      skipped++;
      continue;
    }
    const server: Server = {
      ...baseServer(),
      name,
      hostname,
      port,
      username: user,
      colorHex: PALETTE[(added + i) % PALETTE.length],
    };
    const keyFile = String(s.PublicKeyFile ?? '').trim();
    if (keyFile && fs.existsSync(keyFile)) {
      try {
        const key = await importKeyFromPath(store, keyFile, path.basename(keyFile));
        server.auth = 'key';
        server.keyID = key.id;
        keys++;
      } catch (err) {
        warnings.push(`${name}: ключ ${path.basename(keyFile)} не прочитан — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    store.saveServer(server);
    added++;
  }

  if (!sessions.length) lines.push('Сохранённых сессий PuTTY не найдено.');
  else lines.push(added ? `Добавлено серверов: ${added}` : 'Новых серверов нет.');
  if (keys) lines.push(`Подключено ключей .ppk: ${keys}`);
  if (skipped) lines.push(`Уже были в списке: ${skipped}`);
  if (nonSsh) warnings.push(`Пропущено сессий не по SSH (telnet, serial и т.п.): ${nonSsh}`);
  return { lines, warnings };
}
