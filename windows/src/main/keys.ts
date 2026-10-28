// SSH-ключи: генерация Ed25519, импорт (OpenSSH, PEM, PuTTY .ppk), публичная часть.
import { dialog, type BrowserWindow } from 'electron';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { utils } from 'ssh2';
import type { SSHKeyItem } from '../shared/types';
import { isoNow, newId, type Store } from './store';

type ParsedKey = { type: string; comment: string; getPublicSSH(): Buffer; isPrivateKey(): boolean };

function keyTypeLabel(sshType: string): string {
  if (sshType === 'ssh-ed25519') return 'ED25519';
  if (sshType === 'ssh-rsa') return 'RSA';
  if (sshType.startsWith('ecdsa-')) return 'ECDSA';
  if (sshType === 'ssh-dss') return 'DSA';
  return sshType.toUpperCase();
}

/** Приводит текст ключа к виду, который понимает ssh2 (LF, перевод строки в конце). */
export function normalizePem(text: string): string {
  let t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!t.endsWith('\n')) t += '\n';
  return t;
}

function parse(pem: string, passphrase?: string | null): ParsedKey | Error {
  try {
    const res = utils.parseKey(pem, passphrase || undefined) as unknown;
    if (res instanceof Error) return res;
    const key = (Array.isArray(res) ? res[0] : res) as ParsedKey | undefined;
    if (!key) return new Error('Ключ не найден в файле');
    return key;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function isEncryptedError(err: Error): boolean {
  return /no passphrase given|encrypted/i.test(err.message) && !/bad passphrase|integrity check failed|decrypt/i.test(err.message);
}

function friendlyError(err: Error): Error {
  const m = err.message;
  if (/no passphrase given/i.test(m)) return new Error('Ключ защищён паролем — введите пароль от ключа.');
  if (/bad passphrase|integrity check failed|bad decrypt|unable to decrypt/i.test(m)) return new Error('Неверный пароль от ключа.');
  if (/unsupported key format/i.test(m)) return new Error('Неизвестный формат ключа. Поддерживаются OpenSSH, PEM (RSA/ECDSA) и PuTTY .ppk.');
  return new Error(`Не удалось прочитать ключ: ${m}`);
}

/** Публичный ключ из незашифрованного заголовка OpenSSH-контейнера (работает и для ключей с паролем). */
export function publicFromOpenSshContainer(pem: string): { type: string; line: string } | null {
  const m = pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    const magic = 'openssh-key-v1\0';
    if (buf.subarray(0, magic.length).toString('latin1') !== magic) return null;
    let pos = magic.length;
    const readString = (): Buffer => {
      const len = buf.readUInt32BE(pos);
      pos += 4;
      const out = buf.subarray(pos, pos + len);
      pos += len;
      return out;
    };
    readString(); // cipher
    readString(); // kdf
    readString(); // kdf options
    const count = buf.readUInt32BE(pos);
    pos += 4;
    if (count < 1) return null;
    const pub = readString();
    const typeLen = pub.readUInt32BE(0);
    const type = pub.subarray(4, 4 + typeLen).toString('latin1');
    return { type, line: `${type} ${pub.toString('base64')}` };
  } catch {
    return null;
  }
}

function publicLine(key: ParsedKey, comment: string): string {
  const base = `${key.type} ${key.getPublicSSH().toString('base64')}`;
  return comment ? `${base} ${comment}` : base;
}

/** Проверяет ключ и возвращает метаданные. Ключ с паролем без пароля принимается (пароль спросят при подключении). */
export function inspectKey(pemText: string, passphrase?: string | null, comment = ''): {
  pem: string; type: string; publicKey: string; encrypted: boolean;
} {
  const pem = normalizePem(pemText);
  const plain = parse(pem);
  if (!(plain instanceof Error)) {
    if (!plain.isPrivateKey()) throw new Error('Это публичный ключ. Нужен приватный (без .pub).');
    return { pem, type: keyTypeLabel(plain.type), publicKey: publicLine(plain, comment), encrypted: false };
  }
  if (!isEncryptedError(plain)) throw friendlyError(plain);
  // Ключ зашифрован.
  if (passphrase) {
    const dec = parse(pem, passphrase);
    if (dec instanceof Error) throw friendlyError(dec);
    return { pem, type: keyTypeLabel(dec.type), publicKey: publicLine(dec, comment), encrypted: true };
  }
  const header = publicFromOpenSshContainer(pem);
  return {
    pem,
    type: header ? keyTypeLabel(header.type) : 'RSA',
    publicKey: header ? (comment ? `${header.line} ${comment}` : header.line) : '',
    encrypted: true,
  };
}

export function generateKey(store: Store, name: string, passphrase?: string): SSHKeyItem {
  const title = name.trim() || 'termuxx';
  const opts: Record<string, unknown> = { comment: title };
  if (passphrase) {
    opts.passphrase = passphrase;
    opts.cipher = 'aes256-ctr';
  }
  const pair = utils.generateKeyPairSync('ed25519', opts as never) as { private: string; public: string };
  const item: SSHKeyItem = {
    id: newId(),
    name: title,
    type: 'ED25519',
    publicKey: pair.public.trim(),
    created: isoNow(),
    encrypted: !!passphrase,
  };
  return store.addKey(item, normalizePem(pair.private), passphrase || null);
}

export function importKey(store: Store, name: string, pemText: string, passphrase?: string): SSHKeyItem {
  if (!pemText.trim()) throw new Error('Вставьте текст приватного ключа.');
  const title = name.trim() || 'Импортированный ключ';
  const info = inspectKey(pemText, passphrase, title);
  const existing = info.publicKey ? findByPublic(store, info.publicKey) : undefined;
  const item: SSHKeyItem = {
    id: existing?.id ?? newId(),
    name: existing?.name ?? title,
    type: info.type,
    publicKey: info.publicKey,
    created: existing?.created ?? isoNow(),
    encrypted: info.encrypted,
  };
  return store.addKey(item, info.pem, info.encrypted ? (passphrase || null) : null);
}

/** Импорт ключа из файла (используется и импортёрами ~/.ssh/config и PuTTY). */
export async function importKeyFromPath(store: Store, file: string, name?: string): Promise<SSHKeyItem> {
  const text = await fsp.readFile(file, 'utf8');
  const title = name || path.basename(file);
  const info = inspectKey(text, null, title);
  const existing = info.publicKey ? findByPublic(store, info.publicKey) : undefined;
  if (existing) return existing;
  const item: SSHKeyItem = {
    id: newId(),
    name: title,
    type: info.type,
    publicKey: info.publicKey,
    created: isoNow(),
    encrypted: info.encrypted,
  };
  return store.addKey(item, info.pem, null);
}

export async function importKeyFile(store: Store, win: BrowserWindow | null): Promise<SSHKeyItem | null> {
  const sshDir = path.join(os.homedir(), '.ssh');
  const opts: Electron.OpenDialogOptions = {
    title: 'Импорт SSH-ключа',
    defaultPath: sshDir,
    properties: ['openFile', 'showHiddenFiles'],
    filters: [
      { name: 'Приватные ключи', extensions: ['*'] },
      { name: 'PuTTY', extensions: ['ppk'] },
      { name: 'PEM', extensions: ['pem', 'key'] },
    ],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  const file = res.filePaths[0];
  if (file.endsWith('.pub')) throw new Error('Это публичный ключ (.pub). Выберите файл без расширения .pub.');
  return importKeyFromPath(store, file);
}

function findByPublic(store: Store, publicKey: string): SSHKeyItem | undefined {
  const blob = publicKey.split(/\s+/).slice(0, 2).join(' ');
  if (!blob) return undefined;
  return store.data().keys.find((k) => k.publicKey.split(/\s+/).slice(0, 2).join(' ') === blob);
}
