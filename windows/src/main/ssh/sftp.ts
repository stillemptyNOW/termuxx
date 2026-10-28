// SFTP поверх SSH-подключения сессии: список файлов, операции, передачи с прогрессом, «открыть во внешнем редакторе».
import { BrowserWindow, dialog, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { IPC } from '../../shared/api';
import type { RemoteEntry, TransferProgress } from '../../shared/types';
import type { MainContext } from '../contracts';
import { SshSession, requireSession } from './session';
import { UserFacingError, friendlyError, posixBasename, posixDirname, posixJoin } from './util';

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_EXTERNAL_BYTES = 100 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 150;

const sftpCache = new Map<string, Promise<SFTPWrapper>>();

function openSftpChannel(session: SshSession): Promise<SFTPWrapper> {
  const connection = session.connection;
  if (!connection || !connection.isConnected) return Promise.reject(new UserFacingError('Сессия не подключена.'));
  return new Promise<SFTPWrapper>((resolve, reject) => {
    try {
      connection.client.sftp((err, sftp) => {
        if (err) reject(new UserFacingError(`Не удалось открыть SFTP: ${friendlyError(err).message}. Включена ли подсистема sftp на сервере?`));
        else resolve(sftp);
      });
    } catch (err) {
      reject(friendlyError(err));
    }
  });
}

/** Общий SFTP-канал сессии (для панели файлов). */
export function getSftp(session: SshSession): Promise<SFTPWrapper> {
  let pending = sftpCache.get(session.id);
  if (!pending) {
    pending = openSftpChannel(session);
    sftpCache.set(session.id, pending);
    pending.then((sftp) => {
      const drop = () => { if (sftpCache.get(session.id) === pending) sftpCache.delete(session.id); };
      sftp.on('close', drop);
      sftp.on('end', drop);
      session.disposers.add(() => { drop(); try { sftp.end(); } catch { /* ignore */ } });
    }).catch(() => sftpCache.delete(session.id));
  }
  return pending;
}

// --- промисы поверх колбэков ssh2 ---

function call<T>(fn: (cb: (err: Error | undefined | null, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn((err, value) => (err ? reject(friendlyError(err)) : resolve(value as T)));
  });
}

const statP = (s: SFTPWrapper, p: string) => call<Stats>((cb) => s.stat(p, cb));
const lstatP = (s: SFTPWrapper, p: string) => call<Stats>((cb) => s.lstat(p, cb));
const readdirP = (s: SFTPWrapper, p: string) => call<{ filename: string; longname: string; attrs: Stats }[]>((cb) => s.readdir(p, cb));
const mkdirP = (s: SFTPWrapper, p: string) => call<void>((cb) => s.mkdir(p, cb));
const rmdirP = (s: SFTPWrapper, p: string) => call<void>((cb) => s.rmdir(p, cb));
const unlinkP = (s: SFTPWrapper, p: string) => call<void>((cb) => s.unlink(p, cb));
const renameP = (s: SFTPWrapper, a: string, b: string) => call<void>((cb) => s.rename(a, b, cb));
const chmodP = (s: SFTPWrapper, p: string, mode: number) => call<void>((cb) => s.chmod(p, mode, cb));
const realpathP = (s: SFTPWrapper, p: string) => call<string>((cb) => s.realpath(p, cb));

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function ownerFromLongname(longname: string): string | undefined {
  // "-rw-r--r--    1 root     root         1234 Jan  1 00:00 name"
  const parts = longname.trim().split(/\s+/);
  return parts.length >= 4 ? parts[2] : undefined;
}

// --- операции ---

export async function sftpHome(sessionId: string): Promise<string> {
  const sftp = await getSftp(requireSession(sessionId));
  return realpathP(sftp, '.');
}

export async function sftpList(sessionId: string, dir: string): Promise<RemoteEntry[]> {
  const sftp = await getSftp(requireSession(sessionId));
  const target = dir || '.';
  const list = await readdirP(sftp, target);
  const base = target === '.' ? await realpathP(sftp, '.') : target;
  const entries = await Promise.all(list
    .filter((e) => e.filename !== '.' && e.filename !== '..')
    .map(async (e): Promise<RemoteEntry> => {
      const full = posixJoin(base, e.filename);
      const mode = e.attrs.mode ?? 0;
      const isLink = (mode & S_IFMT) === S_IFLNK;
      let isDir = (mode & S_IFMT) === S_IFDIR;
      let size = e.attrs.size ?? 0;
      if (isLink) {
        try {
          const target = await statP(sftp, full);
          isDir = target.isDirectory();
          if (!isDir) size = target.size ?? size;
        } catch {
          isDir = false; // битая ссылка
        }
      }
      return {
        name: e.filename,
        path: full,
        isDir,
        isLink,
        size,
        mtime: e.attrs.mtime ?? 0,
        mode,
        owner: ownerFromLongname(e.longname),
      };
    }));
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' });
  });
  return entries;
}

export async function sftpMkdir(sessionId: string, dir: string): Promise<void> {
  const sftp = await getSftp(requireSession(sessionId));
  await mkdirP(sftp, dir);
}

export async function sftpRename(sessionId: string, from: string, to: string): Promise<void> {
  const sftp = await getSftp(requireSession(sessionId));
  await renameP(sftp, from, to);
}

async function removeRecursive(sftp: SFTPWrapper, target: string): Promise<void> {
  const st = await lstatP(sftp, target);
  if (st.isDirectory()) {
    const list = await readdirP(sftp, target);
    for (const e of list) {
      if (e.filename === '.' || e.filename === '..') continue;
      await removeRecursive(sftp, posixJoin(target, e.filename));
    }
    await rmdirP(sftp, target);
  } else {
    await unlinkP(sftp, target);
  }
}

export async function sftpDelete(sessionId: string, paths: string[]): Promise<void> {
  const sftp = await getSftp(requireSession(sessionId));
  for (const p of paths) {
    if (!p || p === '/' || p === '.') throw new UserFacingError('Эту папку удалить нельзя.');
    await removeRecursive(sftp, p);
  }
}

export async function sftpChmod(sessionId: string, target: string, mode: number): Promise<void> {
  const sftp = await getSftp(requireSession(sessionId));
  await chmodP(sftp, target, mode & 0o7777);
}

export async function sftpReadText(sessionId: string, file: string): Promise<string> {
  const sftp = await getSftp(requireSession(sessionId));
  const st = await statP(sftp, file);
  if (st.isDirectory()) throw new UserFacingError('Это папка, а не файл.');
  if ((st.size ?? 0) > MAX_TEXT_BYTES) throw new UserFacingError('Файл больше 5 МБ — откройте его во внешнем редакторе или скачайте.');
  const data = await call<Buffer>((cb) => sftp.readFile(file, cb as never));
  if (data.includes(0)) throw new UserFacingError('Это двоичный файл — его нельзя открыть как текст.');
  return new TextDecoder('utf-8').decode(data);
}

export async function sftpWriteText(sessionId: string, file: string, text: string): Promise<void> {
  const sftp = await getSftp(requireSession(sessionId));
  await call<void>((cb) => sftp.writeFile(file, Buffer.from(text, 'utf8'), cb as never));
}

// ---------------------------------------------------------------------------
// Передачи

interface TransferFile {
  remote: string;
  local: string;
  size: number;
}

class Transfer {
  readonly id = randomUUID();
  done = 0;
  total = 0;
  filesDone = 0;
  speed = 0;
  name = '';
  state: TransferProgress['state'] = 'running';
  error?: string;
  cancelled = false;
  channel: SFTPWrapper | null = null;
  currentLocal: string | null = null;
  private lastEmit = 0;
  private lastSampleTime = Date.now();
  private lastSampleDone = 0;

  constructor(
    private readonly ctx: MainContext,
    readonly sessionId: string,
    readonly direction: 'download' | 'upload',
    readonly files: TransferFile[],
  ) {
    this.total = files.reduce((n, f) => n + f.size, 0);
  }

  progress(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    const dt = (now - this.lastSampleTime) / 1000;
    if (dt >= 0.25) {
      const instant = Math.max(0, this.done - this.lastSampleDone) / dt;
      this.speed = this.speed ? this.speed * 0.6 + instant * 0.4 : instant;
      this.lastSampleTime = now;
      this.lastSampleDone = this.done;
    }
    this.lastEmit = now;
    const payload: TransferProgress = {
      transferId: this.id,
      sessionId: this.sessionId,
      direction: this.direction,
      name: this.name,
      done: this.done,
      total: this.total,
      files: this.files.length,
      filesDone: this.filesDone,
      speed: this.state === 'running' ? this.speed : 0,
      state: this.state,
      error: this.error,
    };
    this.ctx.broadcast(IPC.transfer, payload);
  }
}

const transfers = new Map<string, Transfer>();

export function cancelTransfer(transferId: string): void {
  const t = transfers.get(transferId);
  if (!t || t.state !== 'running') return;
  t.cancelled = true;
  try { t.channel?.end(); } catch { /* ignore */ }
}

/** Отменить все передачи сессии (при её закрытии). */
export function cancelSessionTransfers(sessionId: string): void {
  for (const t of transfers.values()) {
    if (t.sessionId === sessionId) cancelTransfer(t.id);
  }
}

function focusedWindow(ctx: MainContext): BrowserWindow | undefined {
  return ctx.mainWindow() ?? BrowserWindow.getFocusedWindow() ?? undefined;
}

/** Уникальное локальное имя: «file (1).txt», если такое уже есть. */
function uniqueLocalPath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 10_000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return target;
}

function safeLocalName(name: string): string {
  // Windows не разрешает некоторые символы в именах файлов.
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return cleaned || 'file';
}

async function collectRemote(sftp: SFTPWrapper, remote: string, localTarget: string, files: TransferFile[], dirs: string[]): Promise<void> {
  const st = await statP(sftp, remote);
  if (st.isDirectory()) {
    dirs.push(localTarget);
    const list = await readdirP(sftp, remote);
    for (const e of list) {
      if (e.filename === '.' || e.filename === '..') continue;
      const childRemote = posixJoin(remote, e.filename);
      const childLocal = path.join(localTarget, safeLocalName(e.filename));
      const mode = e.attrs.mode ?? 0;
      if ((mode & S_IFMT) === S_IFLNK) {
        // Ссылки: скачиваем то, на что указывают (кроме циклов на папки).
        try {
          const target = await statP(sftp, childRemote);
          if (target.isDirectory()) continue;
          files.push({ remote: childRemote, local: childLocal, size: target.size ?? 0 });
        } catch { /* битая ссылка */ }
        continue;
      }
      if ((mode & S_IFMT) === S_IFDIR) await collectRemote(sftp, childRemote, childLocal, files, dirs);
      else files.push({ remote: childRemote, local: childLocal, size: e.attrs.size ?? 0 });
    }
  } else {
    files.push({ remote, local: localTarget, size: st.size ?? 0 });
  }
}

export async function sftpDownload(ctx: MainContext, sessionId: string, remotePaths: string[], localDir?: string): Promise<string> {
  const session = requireSession(sessionId);
  if (!remotePaths.length) return '';
  let dir = localDir;
  if (!dir) {
    const win = focusedWindow(ctx);
    const options: Electron.OpenDialogOptions = {
      title: 'Куда сохранить',
      buttonLabel: 'Сохранить сюда',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: path.join(os.homedir(), 'Downloads'),
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return '';
    dir = result.filePaths[0];
  }
  const sftp = await getSftp(session);
  const files: TransferFile[] = [];
  const dirs: string[] = [];
  for (const remote of remotePaths) {
    const target = uniqueLocalPath(path.join(dir, safeLocalName(posixBasename(remote))));
    await collectRemote(sftp, remote, target, files, dirs);
  }
  const transfer = new Transfer(ctx, sessionId, 'download', files);
  transfers.set(transfer.id, transfer);
  void runDownload(session, transfer, dirs);
  return transfer.id;
}

async function runDownload(session: SshSession, t: Transfer, dirs: string[]): Promise<void> {
  try {
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    t.progress(true);
    t.channel = await openSftpChannel(session);
    let base = 0;
    for (const file of t.files) {
      if (t.cancelled) break;
      t.name = posixBasename(file.remote);
      t.currentLocal = file.local;
      fs.mkdirSync(path.dirname(file.local), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        t.channel!.fastGet(file.remote, file.local, {
          concurrency: 64,
          chunkSize: 32768,
          step: (transferred: number) => {
            t.done = base + transferred;
            t.progress();
          },
        }, (err) => (err ? reject(err) : resolve()));
      });
      base += file.size;
      t.done = base;
      t.filesDone++;
      t.currentLocal = null;
      t.progress();
    }
    if (t.cancelled) throw new Error('cancelled');
    t.state = 'done';
  } catch (err) {
    if (t.currentLocal) {
      try { fs.rmSync(t.currentLocal, { force: true }); } catch { /* ignore */ }
    }
    if (t.cancelled) {
      t.state = 'cancelled';
    } else {
      t.state = 'error';
      t.error = friendlyError(err).message;
    }
  } finally {
    try { t.channel?.end(); } catch { /* ignore */ }
    t.channel = null;
    t.progress(true);
    setTimeout(() => transfers.delete(t.id), 60_000).unref?.();
  }
}

function collectLocal(localPath: string, remoteTarget: string, files: TransferFile[], dirs: string[]): void {
  const st = fs.statSync(localPath);
  if (st.isDirectory()) {
    dirs.push(remoteTarget);
    for (const name of fs.readdirSync(localPath)) {
      collectLocal(path.join(localPath, name), posixJoin(remoteTarget, name), files, dirs);
    }
  } else if (st.isFile()) {
    files.push({ local: localPath, remote: remoteTarget, size: st.size });
  }
}

export async function sftpUpload(ctx: MainContext, sessionId: string, remoteDir: string, localPaths?: string[]): Promise<string> {
  const session = requireSession(sessionId);
  let paths = localPaths?.filter(Boolean) ?? [];
  if (!paths.length) {
    const win = focusedWindow(ctx);
    const options: Electron.OpenDialogOptions = {
      title: 'Загрузить на сервер',
      buttonLabel: 'Загрузить',
      properties: ['openFile', 'multiSelections'],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return '';
    paths = result.filePaths;
  }
  const files: TransferFile[] = [];
  const dirs: string[] = [];
  for (const p of paths) {
    collectLocal(p, posixJoin(remoteDir || '.', path.basename(p)), files, dirs);
  }
  const transfer = new Transfer(ctx, sessionId, 'upload', files);
  transfers.set(transfer.id, transfer);
  void runUpload(session, transfer, dirs);
  return transfer.id;
}

async function ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  try {
    const st = await statP(sftp, dir);
    if (st.isDirectory()) return;
    throw new UserFacingError(`На сервере уже есть файл с именем ${posixBasename(dir)}.`);
  } catch (err) {
    if (err instanceof UserFacingError && !/не найдены/.test(err.message)) throw err;
  }
  await mkdirP(sftp, dir);
}

async function runUpload(session: SshSession, t: Transfer, dirs: string[]): Promise<void> {
  let currentRemote: string | null = null;
  try {
    t.progress(true);
    t.channel = await openSftpChannel(session);
    for (const d of dirs) await ensureRemoteDir(t.channel, d);
    let base = 0;
    for (const file of t.files) {
      if (t.cancelled) break;
      t.name = path.basename(file.local);
      currentRemote = file.remote;
      await new Promise<void>((resolve, reject) => {
        t.channel!.fastPut(file.local, file.remote, {
          concurrency: 64,
          chunkSize: 32768,
          step: (transferred: number) => {
            t.done = base + transferred;
            t.progress();
          },
        }, (err) => (err ? reject(err) : resolve()));
      });
      currentRemote = null;
      base += file.size;
      t.done = base;
      t.filesDone++;
      t.progress();
    }
    if (t.cancelled) throw new Error('cancelled');
    t.state = 'done';
  } catch (err) {
    if (t.cancelled) {
      t.state = 'cancelled';
      // Убираем недогруженный файл на сервере.
      if (currentRemote) {
        try {
          const sftp = await getSftp(session);
          await unlinkP(sftp, currentRemote);
        } catch { /* ignore */ }
      }
    } else {
      t.state = 'error';
      t.error = friendlyError(err).message;
    }
  } finally {
    try { t.channel?.end(); } catch { /* ignore */ }
    t.channel = null;
    t.progress(true);
    setTimeout(() => transfers.delete(t.id), 60_000).unref?.();
  }
}

// ---------------------------------------------------------------------------
// Открыть во внешнем редакторе с автозагрузкой изменений

export async function sftpOpenExternal(ctx: MainContext, sessionId: string, remotePath: string): Promise<void> {
  const session = requireSession(sessionId);
  const sftp = await getSftp(session);
  const st = await statP(sftp, remotePath);
  if (st.isDirectory()) throw new UserFacingError('Это папка — её нельзя открыть в редакторе.');
  if ((st.size ?? 0) > MAX_EXTERNAL_BYTES) throw new UserFacingError('Файл больше 100 МБ — скачайте его.');

  const dir = path.join(os.tmpdir(), 'termuxx-edit', session.id.replace(/[^\w.-]/g, '_'), randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const name = safeLocalName(posixBasename(remotePath));
  const local = path.join(dir, name);
  await new Promise<void>((resolve, reject) => {
    sftp.fastGet(remotePath, local, { concurrency: 16, chunkSize: 32768 }, (err) => (err ? reject(friendlyError(err)) : resolve()));
  });

  let lastMtime = fs.statSync(local).mtimeMs;
  let timer: NodeJS.Timeout | null = null;
  let uploading = false;
  let again = false;

  const emit = (state: TransferProgress['state'], error?: string) => {
    const size = fs.existsSync(local) ? fs.statSync(local).size : 0;
    const payload: TransferProgress = {
      transferId: `edit-${session.id}-${name}`,
      sessionId: session.id,
      direction: 'upload',
      name,
      done: state === 'done' ? size : 0,
      total: size,
      files: 1,
      filesDone: state === 'done' ? 1 : 0,
      speed: 0,
      state,
      error,
    };
    ctx.broadcast(IPC.transfer, payload);
  };

  const upload = async () => {
    if (uploading) { again = true; return; }
    uploading = true;
    try {
      if (!fs.existsSync(local)) return;
      const mtime = fs.statSync(local).mtimeMs;
      if (mtime === lastMtime) return;
      lastMtime = mtime;
      emit('running');
      const channel = await getSftp(session);
      await new Promise<void>((resolve, reject) => {
        channel.fastPut(local, remotePath, { concurrency: 16, chunkSize: 32768 }, (err) => (err ? reject(err) : resolve()));
      });
      emit('done');
    } catch (err) {
      emit('error', `Не удалось сохранить ${name} на сервере: ${friendlyError(err).message}`);
    } finally {
      uploading = false;
      if (again) { again = false; void upload(); }
    }
  };

  // Следим за папкой: редакторы часто сохраняют через «записать во временный файл и переименовать».
  const watcher = fs.watch(dir, (_event, filename) => {
    if (filename && filename.toString() !== name) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void upload(), 500);
  });
  watcher.on('error', () => { /* папку удалили — ничего страшного */ });
  session.disposers.add(() => {
    if (timer) clearTimeout(timer);
    watcher.close();
  });

  const error = await shell.openPath(local);
  if (error) throw new UserFacingError(`Не удалось открыть файл: ${error}`);
}

export function remoteParent(p: string): string {
  return posixDirname(p);
}
