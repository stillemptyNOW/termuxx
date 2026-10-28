// Хранилище Termuxx для Windows: данные — в termuxx.json (формат iOS, camelCase),
// секреты (пароли, приватные ключи, пароли от ключей) — в secrets.json, зашифрованном
// через Electron safeStorage (DPAPI в Windows, Keychain/libsecret в других ОС).
import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoreLike } from './contracts';
import {
  DEFAULT_SETTINGS,
  type AppData, type PortForward, type Server, type Settings, type Snippet, type SSHKeyItem,
} from '../shared/types';

type Json = Record<string, unknown>;

export interface SecretsData {
  passwords: Record<string, string>;
  proxyPasswords: Record<string, string>;
  privateKeys: Record<string, string>;
  passphrases: Record<string, string>;
}

export function emptySecrets(): SecretsData {
  return { passwords: {}, proxyPasswords: {}, privateKeys: {}, passphrases: {} };
}

export function newId(): string {
  return randomUUID().toUpperCase();
}

export function normId(id: unknown): string {
  return typeof id === 'string' ? id.trim().toUpperCase() : '';
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Нормализует дату в ISO 8601 без долей секунды (как ждёт iOS). */
export function normDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const STARTER_SNIPPETS: Omit<Snippet, 'id'>[] = [
  { name: 'Нагрузка', command: 'htop || top', runImmediately: true },
  { name: 'Место на диске', command: 'df -h', runImmediately: true },
  { name: 'Память', command: 'free -h', runImmediately: true },
  { name: 'Обновить систему', command: 'sudo apt update && sudo apt upgrade -y', runImmediately: false },
  { name: 'Сервисы с ошибками', command: 'systemctl --failed', runImmediately: true },
  { name: 'Открытые порты', command: 'ss -tulpn', runImmediately: true },
];

function asInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  const r = Math.round(n);
  return r < min || r > max ? def : r;
}

function asStr(v: unknown, def = ''): string {
  return typeof v === 'string' ? v : def;
}

function asBool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

function optId(v: unknown): string | null {
  const s = normId(v);
  return s ? s : null;
}

/** Приводит проброс порта к корректному виду (null — если порт вне диапазона). */
export function normalizeForward(raw: unknown): PortForward | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Json;
  const localPort = asInt(r.localPort, -1, 1, 65535);
  const remotePort = asInt(r.remotePort, -1, 1, 65535);
  const type = r.type === 'remote' || r.type === 'dynamic' ? r.type : r.type === 'local' ? 'local' : undefined;
  if (localPort < 0) return null;
  if (type !== 'dynamic' && remotePort < 0) return null;
  const fwd: PortForward = {
    ...(r as object),
    id: normId(r.id) || newId(),
    name: asStr(r.name),
    localPort,
    remoteHost: asStr(r.remoteHost, '127.0.0.1') || '127.0.0.1',
    remotePort: remotePort < 0 ? 0 : remotePort,
    autoStart: asBool(r.autoStart, true),
  } as PortForward;
  if (type) fwd.type = type;
  return fwd;
}

/** Приводит сервер к корректному виду, сохраняя незнакомые поля. null — если нет id/hostname. */
export function normalizeServer(raw: unknown): Server | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Json;
  const id = normId(r.id);
  const hostname = asStr(r.hostname).trim();
  if (!id || !hostname) return null;
  const auth = r.auth === 'key' || r.auth === 'agent' || r.auth === 'password' ? r.auth : 'password';
  const proxyRaw = r.proxy && typeof r.proxy === 'object' ? (r.proxy as Json) : null;
  const proxy = proxyRaw && asStr(proxyRaw.host).trim()
    ? { host: asStr(proxyRaw.host).trim(), port: asInt(proxyRaw.port, 1080, 1, 65535), username: asStr(proxyRaw.username) }
    : null;
  const forwards = Array.isArray(r.forwards)
    ? (r.forwards.map(normalizeForward).filter(Boolean) as PortForward[])
    : [];
  const server: Server = {
    ...(r as object),
    id,
    name: asStr(r.name),
    hostname,
    port: asInt(r.port, 22, 1, 65535),
    username: asStr(r.username, 'root') || 'root',
    auth,
    keyID: optId(r.keyID),
    startupSnippetID: optId(r.startupSnippetID),
    colorHex: /^#[0-9a-fA-F]{6}$/.test(asStr(r.colorHex)) ? asStr(r.colorHex).toUpperCase() : '#3DDC97',
    lastConnected: normDate(r.lastConnected),
    useTmux: asBool(r.useTmux, false),
    autoReconnect: asBool(r.autoReconnect, true),
    keepAlive: asBool(r.keepAlive, true),
    jumpHostID: optId(r.jumpHostID),
    proxy,
    forwards,
  } as Server;
  if (server.jumpHostID === id) server.jumpHostID = null;
  return server;
}

export function normalizeKey(raw: unknown): SSHKeyItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Json;
  const id = normId(r.id);
  if (!id) return null;
  return {
    ...(r as object),
    id,
    name: asStr(r.name, 'Ключ') || 'Ключ',
    type: asStr(r.type, 'ED25519') || 'ED25519',
    publicKey: asStr(r.publicKey),
    created: normDate(r.created) ?? isoNow(),
    encrypted: typeof r.encrypted === 'boolean' ? r.encrypted : null,
  } as SSHKeyItem;
}

export function normalizeSnippet(raw: unknown): Snippet | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Json;
  const command = asStr(r.command);
  if (!command.trim()) return null;
  return {
    ...(r as object),
    id: normId(r.id) || newId(),
    name: asStr(r.name) || command.slice(0, 24),
    command,
    runImmediately: asBool(r.runImmediately, true),
  } as Snippet;
}

export function normalizeSettings(raw: unknown): Settings {
  const r = raw && typeof raw === 'object' ? (raw as Json) : {};
  const s: Settings = { ...DEFAULT_SETTINGS, ...(r as Partial<Settings>) };
  s.fontSize = asInt(s.fontSize, DEFAULT_SETTINGS.fontSize, 8, 40);
  s.scrollback = asInt(s.scrollback, DEFAULT_SETTINGS.scrollback, 100, 1_000_000);
  s.lineHeight = typeof s.lineHeight === 'number' && s.lineHeight >= 1 && s.lineHeight <= 2 ? s.lineHeight : DEFAULT_SETTINGS.lineHeight;
  if (!['block', 'bar', 'underline'].includes(s.cursorStyle)) s.cursorStyle = DEFAULT_SETTINGS.cursorStyle;
  if (!['mica', 'acrylic', 'none'].includes(s.backgroundMaterial)) s.backgroundMaterial = DEFAULT_SETTINGS.backgroundMaterial;
  if (!/^#[0-9a-fA-F]{6}$/.test(String(s.accentHex))) s.accentHex = DEFAULT_SETTINGS.accentHex;
  return s;
}

/** Ключ known_hosts в формате iOS: "<host в нижнем регистре>:<port>". */
export function hostPortKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

type Listener = (data: AppData) => void;

export class Store implements StoreLike {
  private dir: string;
  private dataPath: string;
  private secretsPath: string;

  private hosts: Server[] = [];
  private keys: SSHKeyItem[] = [];
  private snippets: Snippet[] = [];
  private knownHosts: Record<string, string> = {};
  private settingsValue: Settings = { ...DEFAULT_SETTINGS };
  private extra: Json = {};
  private secrets: SecretsData = emptySecrets();

  /** true, если секреты пишутся без шифрования (нет системного хранилища ключей). */
  secretsInsecure = false;
  private encryptionChecked = false;
  private encryptionAvailable = false;

  private listeners = new Set<Listener>();
  private dataTimer: NodeJS.Timeout | null = null;
  private secretsTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private notifyTimer: NodeJS.Timeout | null = null;

  constructor(dir = app.getPath('userData')) {
    this.dir = dir;
    this.dataPath = path.join(dir, 'termuxx.json');
    this.secretsPath = path.join(dir, 'secrets.json');
  }

  // ---------- загрузка / сохранение ----------

  async load(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    let raw: Json | null = null;
    try {
      raw = JSON.parse(await fsp.readFile(this.dataPath, 'utf8')) as Json;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Повреждённый файл не затираем молча — сохраняем копию.
        try { await fsp.copyFile(this.dataPath, `${this.dataPath}.broken-${Date.now()}`); } catch { /* ignore */ }
      }
    }
    if (raw && typeof raw === 'object') {
      const { hosts, keys, snippets, knownHosts, settings, ...rest } = raw;
      this.extra = rest;
      this.hosts = dedupe((Array.isArray(hosts) ? hosts : []).map(normalizeServer));
      this.keys = dedupe((Array.isArray(keys) ? keys : []).map(normalizeKey));
      this.snippets = dedupe((Array.isArray(snippets) ? snippets : []).map(normalizeSnippet));
      this.knownHosts = knownHosts && typeof knownHosts === 'object'
        ? Object.fromEntries(Object.entries(knownHosts as Json).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : {};
      this.settingsValue = normalizeSettings(settings);
    } else {
      this.snippets = STARTER_SNIPPETS.map((s) => ({ ...s, id: newId() }));
      this.scheduleDataWrite();
    }
    await this.loadSecrets();
  }

  private async checkEncryption(): Promise<boolean> {
    if (this.encryptionChecked) return this.encryptionAvailable;
    this.encryptionChecked = true;
    try {
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000));
      this.encryptionAvailable = await Promise.race([safeStorage.isAsyncEncryptionAvailable(), timeout]);
    } catch {
      this.encryptionAvailable = false;
    }
    return this.encryptionAvailable;
  }

  private async loadSecrets(): Promise<void> {
    let file: Json | null = null;
    try {
      file = JSON.parse(await fsp.readFile(this.secretsPath, 'utf8')) as Json;
    } catch {
      file = null;
    }
    const available = await this.checkEncryption();
    this.secretsInsecure = !available;
    if (!file) return;
    try {
      let obj: Json | null = null;
      if (file.encrypted === true && typeof file.data === 'string') {
        if (!available) throw new Error('safeStorage недоступен');
        const res = await safeStorage.decryptStringAsync(Buffer.from(file.data, 'base64'));
        obj = JSON.parse(res.result) as Json;
        if (res.shouldReEncrypt) this.scheduleSecretsWrite();
      } else if (file.plain && typeof file.plain === 'object') {
        obj = file.plain as Json;
        if (available) this.scheduleSecretsWrite(); // перешифровать, когда хранилище появилось
      }
      if (obj) this.secrets = normalizeSecrets(obj);
    } catch (err) {
      // Не удалось расшифровать (другой пользователь Windows / сброс профиля) — не теряем файл.
      try { await fsp.copyFile(this.secretsPath, `${this.secretsPath}.unreadable-${Date.now()}`); } catch { /* ignore */ }
      console.error('[store] secrets unreadable:', err);
      this.secrets = emptySecrets();
    }
  }

  private scheduleDataWrite(): void {
    if (this.dataTimer) clearTimeout(this.dataTimer);
    this.dataTimer = setTimeout(() => {
      this.dataTimer = null;
      void this.enqueue(() => this.writeData());
    }, 120);
  }

  private scheduleSecretsWrite(): void {
    if (this.secretsTimer) clearTimeout(this.secretsTimer);
    this.secretsTimer = setTimeout(() => {
      this.secretsTimer = null;
      void this.enqueue(() => this.writeSecrets());
    }, 120);
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(job).catch((err) => console.error('[store] write failed:', err));
    return this.writeChain;
  }

  private serialize(): Json {
    return {
      ...this.extra,
      hosts: this.hosts.map(stripNulls),
      keys: this.keys.map(stripNulls),
      snippets: this.snippets,
      knownHosts: this.knownHosts,
      settings: this.settingsValue,
    };
  }

  private async writeData(): Promise<void> {
    await atomicWrite(this.dataPath, JSON.stringify(this.serialize(), null, 2));
  }

  private async writeSecrets(): Promise<void> {
    const json = JSON.stringify(this.secrets);
    const available = await this.checkEncryption();
    let content: Json;
    if (available) {
      const buf = await safeStorage.encryptStringAsync(json);
      content = { version: 1, encrypted: true, data: buf.toString('base64') };
      this.secretsInsecure = false;
    } else {
      content = { version: 1, encrypted: false, plain: this.secrets };
      this.secretsInsecure = true;
    }
    await atomicWrite(this.secretsPath, JSON.stringify(content), 0o600);
  }

  /** Сбросить отложенные записи на диск (перед выходом). */
  async flush(): Promise<void> {
    if (this.dataTimer) { clearTimeout(this.dataTimer); this.dataTimer = null; void this.enqueue(() => this.writeData()); }
    if (this.secretsTimer) { clearTimeout(this.secretsTimer); this.secretsTimer = null; void this.enqueue(() => this.writeSecrets()); }
    await this.writeChain;
  }

  // ---------- подписки ----------

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.scheduleDataWrite();
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const snapshot = this.data();
      for (const l of this.listeners) {
        try { l(snapshot); } catch (err) { console.error('[store] listener failed:', err); }
      }
    }, 16);
  }

  // ---------- StoreLike ----------

  data(): AppData {
    return {
      hosts: this.hosts.map((h) => ({ ...h, forwards: h.forwards.map((f) => ({ ...f })) })),
      keys: this.keys.map((k) => ({ ...k })),
      snippets: this.snippets.map((s) => ({ ...s })),
      knownHosts: { ...this.knownHosts },
      settings: { ...this.settingsValue },
    };
  }

  server(id: string): Server | undefined {
    const n = normId(id);
    return this.hosts.find((h) => h.id === n);
  }

  snippet(id: string): Snippet | undefined {
    const n = normId(id);
    return this.snippets.find((s) => s.id === n);
  }

  key(id: string): SSHKeyItem | undefined {
    const n = normId(id);
    return this.keys.find((k) => k.id === n);
  }

  settings(): Settings {
    return { ...this.settingsValue };
  }

  password(serverId: string): string | null {
    return this.secrets.passwords[normId(serverId)] ?? null;
  }

  setPassword(serverId: string, password: string | null): void {
    setSecret(this.secrets.passwords, serverId, password);
    this.scheduleSecretsWrite();
  }

  hasPassword(serverId: string): boolean {
    return !!this.secrets.passwords[normId(serverId)];
  }

  proxyPassword(serverId: string): string | null {
    return this.secrets.proxyPasswords[normId(serverId)] ?? null;
  }

  setProxyPassword(serverId: string, password: string | null): void {
    setSecret(this.secrets.proxyPasswords, serverId, password);
    this.scheduleSecretsWrite();
  }

  privateKey(keyId: string): string | null {
    return this.secrets.privateKeys[normId(keyId)] ?? null;
  }

  setPrivateKey(keyId: string, pem: string | null): void {
    setSecret(this.secrets.privateKeys, keyId, pem);
    this.scheduleSecretsWrite();
  }

  passphrase(keyId: string): string | null {
    return this.secrets.passphrases[normId(keyId)] ?? null;
  }

  setPassphrase(keyId: string, passphrase: string | null): void {
    setSecret(this.secrets.passphrases, keyId, passphrase);
    this.scheduleSecretsWrite();
  }

  knownHost(hostPort: string): string | null {
    return this.knownHosts[hostPort.trim().toLowerCase()] ?? this.knownHosts[hostPort] ?? null;
  }

  setKnownHost(hostPort: string, fingerprint: string): void {
    this.knownHosts[hostPort.trim().toLowerCase()] = fingerprint;
    this.changed();
  }

  forgetHostKey(hostPort: string): void {
    const k = hostPort.trim().toLowerCase();
    let removed = false;
    for (const key of [k, hostPort]) {
      if (key in this.knownHosts) { delete this.knownHosts[key]; removed = true; }
    }
    if (removed) this.changed();
  }

  markConnected(serverId: string): void {
    const s = this.server(serverId);
    if (!s) return;
    s.lastConnected = isoNow();
    this.changed();
  }

  saveServer(server: Server): void {
    const existing = this.server(server.id);
    const merged = normalizeServer({ ...(existing ?? {}), ...server });
    if (!merged) throw new Error('У сервера должен быть адрес');
    const i = this.hosts.findIndex((h) => h.id === merged.id);
    if (i >= 0) this.hosts[i] = merged; else this.hosts.push(merged);
    this.changed();
  }

  deleteServer(id: string): void {
    const n = normId(id);
    const before = this.hosts.length;
    this.hosts = this.hosts.filter((h) => h.id !== n);
    for (const h of this.hosts) if (h.jumpHostID === n) h.jumpHostID = null;
    delete this.secrets.passwords[n];
    delete this.secrets.proxyPasswords[n];
    this.scheduleSecretsWrite();
    if (this.hosts.length !== before) this.changed();
  }

  saveSnippet(snippet: Snippet): void {
    const s = normalizeSnippet(snippet);
    if (!s) throw new Error('У сниппета должна быть команда');
    const i = this.snippets.findIndex((x) => x.id === s.id);
    if (i >= 0) this.snippets[i] = s; else this.snippets.push(s);
    this.changed();
  }

  deleteSnippet(id: string): void {
    const n = normId(id);
    this.snippets = this.snippets.filter((s) => s.id !== n);
    for (const h of this.hosts) if (h.startupSnippetID === n) h.startupSnippetID = null;
    this.changed();
  }

  saveSettings(settings: Settings): void {
    this.settingsValue = normalizeSettings({ ...this.settingsValue, ...settings });
    this.changed();
  }

  addKey(item: SSHKeyItem, pem: string, passphrase: string | null): SSHKeyItem {
    const k = normalizeKey(item);
    if (!k) throw new Error('Некорректный ключ');
    const i = this.keys.findIndex((x) => x.id === k.id);
    if (i >= 0) this.keys[i] = k; else this.keys.push(k);
    setSecret(this.secrets.privateKeys, k.id, pem);
    setSecret(this.secrets.passphrases, k.id, passphrase);
    this.scheduleSecretsWrite();
    this.changed();
    return { ...k };
  }

  /** Обновить метаданные ключа (без изменения секретов). */
  upsertKeyMeta(item: SSHKeyItem): void {
    const k = normalizeKey(item);
    if (!k) return;
    const i = this.keys.findIndex((x) => x.id === k.id);
    if (i >= 0) this.keys[i] = k; else this.keys.push(k);
    this.changed();
  }

  deleteKey(id: string): void {
    const n = normId(id);
    this.keys = this.keys.filter((k) => k.id !== n);
    for (const h of this.hosts) {
      if (h.keyID === n) {
        h.keyID = null;
        if (h.auth === 'key') h.auth = 'password';
      }
    }
    delete this.secrets.privateKeys[n];
    delete this.secrets.passphrases[n];
    this.scheduleSecretsWrite();
    this.changed();
  }

  /** Все секреты (для экспорта в бэкап). */
  allSecrets(): SecretsData {
    return JSON.parse(JSON.stringify(this.secrets)) as SecretsData;
  }

  /** Слияние импортированных данных (правила — docs/BACKUP_FORMAT.md). */
  merge(input: {
    hosts: Server[];
    keys: SSHKeyItem[];
    snippets: Snippet[];
    knownHosts: Record<string, string>;
    secrets: SecretsData | null;
  }): { hostsAdded: number; hostsUpdated: number; keysAdded: number; keysUpdated: number; snippetsAdded: number; snippetsUpdated: number; knownAdded: number; knownConflicts: number; secretsWritten: number } {
    const r = { hostsAdded: 0, hostsUpdated: 0, keysAdded: 0, keysUpdated: 0, snippetsAdded: 0, snippetsUpdated: 0, knownAdded: 0, knownConflicts: 0, secretsWritten: 0 };
    for (const h of input.hosts) {
      const i = this.hosts.findIndex((x) => x.id === h.id);
      if (i >= 0) {
        const old = this.hosts[i];
        const later = laterDate(old.lastConnected ?? null, h.lastConnected ?? null);
        this.hosts[i] = { ...old, ...h, lastConnected: later };
        r.hostsUpdated++;
      } else {
        this.hosts.push(h);
        r.hostsAdded++;
      }
    }
    for (const k of input.keys) {
      const i = this.keys.findIndex((x) => x.id === k.id);
      if (i >= 0) { this.keys[i] = { ...this.keys[i], ...k }; r.keysUpdated++; } else { this.keys.push(k); r.keysAdded++; }
    }
    for (const s of input.snippets) {
      const i = this.snippets.findIndex((x) => x.id === s.id);
      if (i >= 0) { this.snippets[i] = s; r.snippetsUpdated++; } else { this.snippets.push(s); r.snippetsAdded++; }
    }
    for (const [hp, fp] of Object.entries(input.knownHosts)) {
      const key = hp.trim().toLowerCase();
      const existing = this.knownHosts[key];
      if (existing === undefined) { this.knownHosts[key] = fp; r.knownAdded++; } else if (existing !== fp) { r.knownConflicts++; }
    }
    if (input.secrets) {
      for (const section of ['passwords', 'proxyPasswords', 'privateKeys', 'passphrases'] as const) {
        for (const [id, value] of Object.entries(input.secrets[section])) {
          if (typeof value === 'string' && value) {
            this.secrets[section][normId(id)] = value;
            r.secretsWritten++;
          }
        }
      }
      this.scheduleSecretsWrite();
    }
    this.changed();
    return r;
  }
}

// ---------- помощники ----------

function dedupe<T extends { id: string }>(items: (T | null)[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

function setSecret(map: Record<string, string>, id: string, value: string | null): void {
  const k = normId(id);
  if (!k) return;
  if (value) map[k] = value; else delete map[k];
}

export function normalizeSecrets(obj: Json): SecretsData {
  const out = emptySecrets();
  for (const section of ['passwords', 'proxyPasswords', 'privateKeys', 'passphrases'] as const) {
    const src = obj[section];
    if (!src || typeof src !== 'object') continue;
    for (const [id, value] of Object.entries(src as Json)) {
      if (typeof value === 'string' && value && normId(id)) out[section][normId(id)] = value;
    }
  }
  return out;
}

/** Убирает null/undefined верхнего уровня — iOS опускает пустые необязательные поля. */
export function stripNulls<T extends object>(obj: T): T {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as T;
}

function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

async function atomicWrite(file: string, content: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, content, { encoding: 'utf8', mode });
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    // Windows: rename поверх занятого файла иногда даёт EPERM/EBUSY — пробуем ещё раз.
    await new Promise((r) => setTimeout(r, 50));
    try {
      await fsp.rename(tmp, file);
    } catch {
      await fsp.writeFile(file, content, { encoding: 'utf8', mode });
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (!(err instanceof Error)) throw err;
    }
  }
}
