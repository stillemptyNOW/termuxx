// Вспомогательные функции инструментов рабочей области (SFTP, мониторинг, туннели).
import type { RemoteEntry } from '../../shared/types';
import { formatBytes } from '../ui/kit';

/** API main-процесса. */
export const api = () => window.termuxx;

/** Текст ошибки без обёртки ipcRenderer.invoke. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- пути ----------

export function joinPath(dir: string, name: string): string {
  if (!dir || dir === '/') return '/' + name.replace(/^\/+/, '');
  return dir.replace(/\/+$/, '') + '/' + name.replace(/^\/+/, '');
}

export function parentPath(path: string): string {
  if (!path || path === '/') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1) || '/';
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Имя файла допустимо для создания/переименования. */
export function validName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Введите имя';
  if (n === '.' || n === '..') return 'Недопустимое имя';
  if (n.includes('/')) return 'Имя не может содержать «/»';
  return null;
}

// ---------- права ----------

export function modeString(mode: number, isDir: boolean, isLink: boolean): string {
  const type = isLink ? 'l' : isDir ? 'd' : '-';
  const chars = ['r', 'w', 'x'];
  let s = type;
  for (let i = 8; i >= 0; i--) {
    s += (mode >> i) & 1 ? chars[(8 - i) % 3] : '-';
  }
  // setuid/setgid/sticky
  const special = (mode >> 9) & 0o7;
  const arr = s.split('');
  if (special & 4) arr[3] = arr[3] === 'x' ? 's' : 'S';
  if (special & 2) arr[6] = arr[6] === 'x' ? 's' : 'S';
  if (special & 1) arr[9] = arr[9] === 'x' ? 't' : 'T';
  return arr.join('');
}

export function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0');
}

// ---------- время и скорость ----------

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateFmtShort = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function formatDate(unixSeconds: number, short = false): string {
  if (!unixSeconds) return '—';
  const d = new Date(unixSeconds * 1000);
  return (short ? dateFmtShort : dateFmt).format(d);
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 Б/с';
  return `${formatBytes(bytesPerSecond)}/с`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.ceil(seconds);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export function percent(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n)}%`;
}

/** Цвет по загрузке: зелёный → жёлтый → красный. */
export function levelColor(fraction: number): string {
  if (fraction >= 0.9) return 'var(--danger)';
  if (fraction >= 0.7) return 'var(--warning)';
  return 'var(--accent)';
}

// ---------- типы файлов ----------

export type FileKind =
  | 'dir' | 'link' | 'image' | 'video' | 'audio' | 'archive' | 'code' | 'config'
  | 'text' | 'key' | 'binary' | 'pdf' | 'doc' | 'file';

const KIND_BY_EXT: Record<string, FileKind> = {};
const add = (kind: FileKind, exts: string) => exts.split(' ').forEach((e) => { KIND_BY_EXT[e] = kind; });
add('image', 'png jpg jpeg gif webp bmp ico svg heic tif tiff avif');
add('video', 'mp4 mov mkv avi webm m4v flv wmv');
add('audio', 'mp3 wav flac ogg m4a aac opus');
add('archive', 'zip gz tgz xz bz2 tar 7z rar zst deb rpm apk jar war iso');
add('code', 'sh bash zsh fish py js mjs cjs ts tsx jsx go rs c h cc cpp hpp cs java kt swift rb php pl lua sql ps1 bat cmd vue svelte dart scala r');
add('config', 'conf cfg ini yml yaml toml json json5 env properties service timer socket rules xml plist lock');
add('text', 'txt md log csv tsv rst nfo readme diff patch');
add('key', 'pem key pub crt cer csr p12 pfx der gpg asc');
add('binary', 'bin so o a exe dll dylib out img');
add('pdf', 'pdf');
add('doc', 'doc docx xls xlsx ppt pptx odt ods odp rtf');

const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'readme', 'license', 'authorized_keys', 'known_hosts', 'config', 'hosts',
  'crontab', 'fstab', 'passwd', 'group', 'sudoers', 'environment', 'profile', 'vimrc', 'caddyfile',
  '.bashrc', '.bash_profile', '.profile', '.zshrc', '.vimrc', '.gitconfig', '.gitignore', '.env',
  '.bash_history', '.bash_logout', '.tmux.conf', '.inputrc', '.npmrc', '.editorconfig', '.dockerignore',
]);

export function fileKind(entry: Pick<RemoteEntry, 'name' | 'isDir' | 'isLink'>): FileKind {
  if (entry.isDir) return 'dir';
  const ext = extOf(entry.name);
  if (ext && KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  if (entry.isLink) return 'link';
  const lower = entry.name.toLowerCase();
  if (TEXT_NAMES.has(lower) || lower.startsWith('.')) return 'config';
  return 'file';
}

/** Можно ли открыть файл во встроенном редакторе. */
export function isEditable(entry: Pick<RemoteEntry, 'name' | 'isDir' | 'size'>): boolean {
  if (entry.isDir) return false;
  if (entry.size > 5 * 1024 * 1024) return false;
  const kind = fileKind({ name: entry.name, isDir: false, isLink: false });
  if (kind === 'code' || kind === 'config' || kind === 'text') return true;
  if (kind === 'key') return extOf(entry.name) !== 'p12' && extOf(entry.name) !== 'pfx' && extOf(entry.name) !== 'der';
  // Файлы без расширения (скрипты, конфиги) — пробуем как текст, если небольшие.
  return kind === 'file' && entry.size <= 512 * 1024;
}

// ---------- прочее ----------

/** Сортировка с учётом чисел и русского алфавита. */
export const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Сохранение мелких настроек панели между запусками. */
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`termuxx.tools.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`termuxx.tools.${key}`, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — не страшно */
  }
}
