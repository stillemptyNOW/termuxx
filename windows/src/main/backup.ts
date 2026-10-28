// Резервная копия Termuxx (.termuxx): совместима с iOS и Linux — см. docs/BACKUP_FORMAT.md.
import { app, dialog, type BrowserWindow } from 'electron';
import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupPreview, ImportSummary, Server, Snippet, SSHKeyItem } from '../shared/types';
import {
  isoNow, normalizeKey, normalizeSecrets, normalizeServer, normalizeSnippet, normDate, stripNulls,
  emptySecrets, type SecretsData, type Store,
} from './store';

export const BACKUP_FORMAT = 'termuxx-backup';
export const BACKUP_VERSION = 1;
export const KDF_ITERATIONS = 200_000;

interface SecretsBlock {
  kdf: string;
  iterations: number;
  salt: string;
  cipher: string;
  nonce: string;
  data: string;
}

type Json = Record<string, unknown>;

function deriveKey(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
  const pw = Buffer.from(password.normalize('NFC'), 'utf8');
  return new Promise((resolve, reject) => {
    pbkdf2(pw, salt, iterations, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function encryptSecrets(secrets: SecretsData, password: string): Promise<SecretsBlock> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    kdf: 'pbkdf2-sha256',
    iterations: KDF_ITERATIONS,
    salt: salt.toString('base64'),
    cipher: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
    data: Buffer.concat([ct, tag]).toString('base64'),
  };
}

export async function decryptSecrets(block: Json, password: string): Promise<SecretsData> {
  if (block.kdf !== 'pbkdf2-sha256' || block.cipher !== 'aes-256-gcm') {
    throw new Error('Неизвестный способ шифрования секретов в бэкапе.');
  }
  const iterations = Number(block.iterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) {
    throw new Error('Повреждённый бэкап: неверное число итераций.');
  }
  const salt = Buffer.from(String(block.salt ?? ''), 'base64');
  const nonce = Buffer.from(String(block.nonce ?? ''), 'base64');
  const data = Buffer.from(String(block.data ?? ''), 'base64');
  if (salt.length < 8 || nonce.length !== 12 || data.length < 17) throw new Error('Повреждённый бэкап: секреты обрезаны.');
  const key = await deriveKey(password, salt, iterations);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  } catch {
    throw new Error('Неверный пароль бэкапа.');
  }
  return normalizeSecrets(JSON.parse(plain.toString('utf8')) as Json);
}

function defaultFileName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `termuxx-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.termuxx`;
}

/** Собрать бэкап в виде объекта (без записи на диск). */
export async function buildBackup(store: Store, includeSecrets: boolean, password?: string): Promise<Json> {
  const data = store.data();
  let secrets: SecretsBlock | null = null;
  if (includeSecrets) {
    if (!password) throw new Error('Придумайте пароль для резервной копии.');
    const all = store.allSecrets();
    const hostIds = new Set(data.hosts.map((h) => h.id));
    const keyIds = new Set(data.keys.map((k) => k.id));
    const filtered: SecretsData = emptySecrets();
    for (const [id, v] of Object.entries(all.passwords)) if (hostIds.has(id)) filtered.passwords[id] = v;
    for (const [id, v] of Object.entries(all.proxyPasswords)) if (hostIds.has(id)) filtered.proxyPasswords[id] = v;
    for (const [id, v] of Object.entries(all.privateKeys)) if (keyIds.has(id)) filtered.privateKeys[id] = v;
    for (const [id, v] of Object.entries(all.passphrases)) if (keyIds.has(id)) filtered.passphrases[id] = v;
    secrets = await encryptSecrets(filtered, password);
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: 'windows',
    createdAt: isoNow(),
    hosts: data.hosts.map((h) => stripNulls({
      ...h,
      lastConnected: normDate(h.lastConnected) ?? null,
      forwards: h.forwards.map((f) => stripNulls(f)),
    })),
    keys: data.keys.map((k) => stripNulls({ ...k, created: normDate(k.created) ?? isoNow() })),
    snippets: data.snippets,
    knownHosts: data.knownHosts,
    secrets,
  };
}

export async function exportBackup(store: Store, win: BrowserWindow | null, includeSecrets: boolean, password?: string): Promise<string | null> {
  if (includeSecrets && !password) throw new Error('Придумайте пароль для резервной копии.');
  const opts: Electron.SaveDialogOptions = {
    title: 'Сохранить резервную копию Termuxx',
    defaultPath: path.join(app.getPath('documents'), defaultFileName()),
    filters: [{ name: 'Резервная копия Termuxx', extensions: ['termuxx'] }],
  };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return null;
  const backup = await buildBackup(store, includeSecrets, password);
  await fsp.writeFile(res.filePath, JSON.stringify(backup, null, 2), 'utf8');
  return res.filePath;
}

async function readBackup(file: string): Promise<Json> {
  let raw: Json;
  try {
    raw = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')) as Json;
  } catch {
    throw new Error('Это не резервная копия Termuxx (файл не JSON).');
  }
  if (!raw || raw.format !== BACKUP_FORMAT) throw new Error('Это не резервная копия Termuxx.');
  const version = Number(raw.version);
  if (!Number.isInteger(version) || version > BACKUP_VERSION) {
    throw new Error('Резервная копия создана более новой версией Termuxx — обновите приложение.');
  }
  return raw;
}

export function previewOf(raw: Json): BackupPreview {
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return {
    app: typeof raw.app === 'string' ? raw.app : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    hosts: count(raw.hosts),
    keys: count(raw.keys),
    snippets: count(raw.snippets),
    knownHosts: raw.knownHosts && typeof raw.knownHosts === 'object' ? Object.keys(raw.knownHosts as Json).length : 0,
    hasSecrets: !!raw.secrets && typeof raw.secrets === 'object',
  };
}

export async function inspectBackup(win: BrowserWindow | null): Promise<{ path: string; preview: BackupPreview } | null> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Открыть резервную копию Termuxx',
    defaultPath: app.getPath('documents'),
    properties: ['openFile'],
    filters: [
      { name: 'Резервная копия Termuxx', extensions: ['termuxx', 'json'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  const raw = await readBackup(res.filePaths[0]);
  return { path: res.filePaths[0], preview: previewOf(raw) };
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Импорт: сначала всё проверяем и расшифровываем, потом сливаем (неверный пароль ничего не меняет). */
export async function importBackup(store: Store, file: string, password?: string): Promise<ImportSummary> {
  const raw = await readBackup(file);
  return importBackupObject(store, raw, password);
}

export async function importBackupObject(store: Store, raw: Json, password?: string): Promise<ImportSummary> {
  const warnings: string[] = [];
  const lines: string[] = [];

  let secrets: SecretsData | null = null;
  const hasSecrets = !!raw.secrets && typeof raw.secrets === 'object';
  if (hasSecrets) {
    if (password) {
      secrets = await decryptSecrets(raw.secrets as Json, password);
    } else {
      warnings.push('Пароль не введён — пароли и ключи не импортированы, только список серверов.');
    }
  }

  const hostsRaw = Array.isArray(raw.hosts) ? raw.hosts : [];
  const hosts: Server[] = [];
  let skippedHosts = 0;
  for (const h of hostsRaw) {
    const s = normalizeServer(h);
    if (s) hosts.push(s); else skippedHosts++;
  }
  // Проброс с портом вне 1…65535 normalizeServer уже отбросил — считаем для предупреждения.
  let droppedForwards = 0;
  for (const h of hostsRaw) {
    const f = (h as Json | null)?.forwards;
    if (Array.isArray(f)) droppedForwards += f.length;
  }
  droppedForwards -= hosts.reduce((acc, h) => acc + h.forwards.length, 0);

  const keysRaw = Array.isArray(raw.keys) ? raw.keys : [];
  const keys: SSHKeyItem[] = [];
  let skippedKeys = 0;
  for (const k of keysRaw) {
    const key = normalizeKey(k);
    if (key) keys.push(key); else skippedKeys++;
  }

  const snippetsRaw = Array.isArray(raw.snippets) ? raw.snippets : [];
  const snippets: Snippet[] = [];
  let skippedSnippets = 0;
  for (const s of snippetsRaw) {
    const sn = normalizeSnippet(s);
    if (sn) snippets.push(sn); else skippedSnippets++;
  }

  const knownHosts: Record<string, string> = {};
  if (raw.knownHosts && typeof raw.knownHosts === 'object') {
    for (const [k, v] of Object.entries(raw.knownHosts as Json)) {
      if (typeof v === 'string' && v) knownHosts[k.toLowerCase()] = v;
    }
  }

  const r = store.merge({ hosts, keys, snippets, knownHosts, secrets });

  const part = (label: string, added: number, updated: number) => {
    if (!added && !updated) return;
    const bits: string[] = [];
    if (added) bits.push(`добавлено ${added}`);
    if (updated) bits.push(`обновлено ${updated}`);
    lines.push(`${label}: ${bits.join(', ')}`);
  };
  part('Серверы', r.hostsAdded, r.hostsUpdated);
  part('Ключи', r.keysAdded, r.keysUpdated);
  part('Сниппеты', r.snippetsAdded, r.snippetsUpdated);
  if (r.knownAdded) lines.push(`Отпечатки серверов: добавлено ${r.knownAdded}`);
  if (secrets) lines.push(`Пароли и ключи: ${r.secretsWritten} ${plural(r.secretsWritten, 'запись', 'записи', 'записей')}`);
  if (!lines.length) lines.push('Нечего импортировать — бэкап пуст.');

  if (skippedHosts) warnings.push(`Пропущено серверов без адреса: ${skippedHosts}`);
  if (skippedKeys) warnings.push(`Пропущено повреждённых ключей: ${skippedKeys}`);
  if (skippedSnippets) warnings.push(`Пропущено пустых сниппетов: ${skippedSnippets}`);
  if (droppedForwards > 0) warnings.push(`Пропущено пробросов с неверным портом: ${droppedForwards}`);
  if (r.knownConflicts) warnings.push(`Отпечатков, отличающихся от сохранённых, не перезаписано: ${r.knownConflicts}`);
  const keysWithoutPem = keys.filter((k) => !store.privateKey(k.id)).length;
  if (keysWithoutPem && !secrets) warnings.push(`Ключей без приватной части: ${keysWithoutPem} — импортируйте бэкап с паролем.`);

  return { lines, warnings };
}
