// Вспомогательные функции SSH-слоя: экранирование, пути, отпечатки ключей, exec, понятные ошибки.
import { createHash } from 'node:crypto';
import type { Client } from 'ssh2';
import type { Server } from '../../shared/types';

/** Экранирует строку для POSIX shell. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Оборачивает скрипт в `sh -c '…'`, чтобы он работал при любой оболочке пользователя (bash, zsh, fish). */
export function sh(script: string): string {
  return `sh -c ${shQuote(script)}`;
}

export function posixJoin(dir: string, name: string): string {
  if (!dir || dir === '/') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

export function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function posixDirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  if (i <= 0) return '/';
  return trimmed.slice(0, i);
}

export function serverLabel(server: Server): string {
  return `${server.username}@${server.hostname}${server.port && server.port !== 22 ? `:${server.port}` : ''}`;
}

export function hostPortKey(server: Pick<Server, 'hostname' | 'port'>): string {
  return `${server.hostname.trim().toLowerCase()}:${server.port || 22}`;
}

/** Тип ключа и отпечаток SHA256 из «сырого» blob ключа сервера (как `ssh-keygen -l`). */
export function hostKeyFingerprint(blob: Buffer): { keyType: string; fingerprint: string } {
  let keyType = 'unknown';
  if (blob.length >= 4) {
    const len = blob.readUInt32BE(0);
    if (len > 0 && len < 64 && blob.length >= 4 + len) keyType = blob.subarray(4, 4 + len).toString('latin1');
  }
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { keyType, fingerprint: `SHA256:${digest}` };
}

/** Таймер с паузой: пока пользователь отвечает на вопрос, время подключения не идёт. */
export class Deadline {
  private timer: NodeJS.Timeout | null = null;
  private remaining: number;
  private startedAt = 0;
  private done = false;
  private pauses = 0;

  constructor(private readonly ms: number, private readonly onFire: () => void) {
    this.remaining = ms;
  }

  start(): void {
    if (this.done || this.timer || this.pauses > 0) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.done) return;
      this.done = true;
      this.onFire();
    }, this.remaining);
  }

  pause(): void {
    this.pauses++;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(1000, this.remaining - (Date.now() - this.startedAt));
  }

  /** После ответа пользователя даём серверу полный срок заново. */
  resume(): void {
    if (this.pauses > 0) this.pauses--;
    if (this.pauses > 0 || this.done) return;
    this.remaining = this.ms;
    this.start();
  }

  clear(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface ExecResult {
  code: number | null;
  output: string;
}

/** Выполнить команду и собрать stdout+stderr. */
export function execCommand(
  client: Client,
  command: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    try {
      client.exec(command, (err, stream) => {
        if (err) {
          settled = true;
          reject(friendlyError(err));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let code: number | null = null;
        const collect = (buf: Buffer) => {
          if (size >= maxBytes) return;
          chunks.push(buf);
          size += buf.length;
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { stream.close(); } catch { /* уже закрыт */ }
          reject(new Error('Команда выполнялась слишком долго.'));
        }, timeoutMs);
        stream.on('data', collect);
        stream.stderr.on('data', collect);
        stream.on('exit', (exitCode: number | null) => { code = exitCode; });
        stream.on('close', (exitCode?: number | null) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (code === null && typeof exitCode === 'number') code = exitCode;
          resolve({ code, output: Buffer.concat(chunks).toString('utf8') });
        });
        stream.on('error', (e: Error) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(friendlyError(e));
        });
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        reject(friendlyError(e));
      }
    }
  });
}

/** Ошибка с уже понятным пользователю текстом (не переводится повторно). */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

interface ErrorWithInfo {
  code?: string | number;
  level?: string;
  message?: string;
}

/** Переводит системные ошибки ssh2/сокетов/SFTP в понятный русский текст. */
export function friendlyMessage(err: unknown, server?: Server): string {
  if (err instanceof UserFacingError) return err.message;
  const e = (err ?? {}) as ErrorWithInfo;
  const raw = String(e.message ?? err ?? '');
  const code = e.code;
  const where = server ? `${server.hostname}:${server.port || 22}` : 'сервер';

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(raw)) {
    return `Не удалось найти сервер «${server?.hostname ?? ''}». Проверьте адрес.`.replace('«»', '');
  }
  if (code === 'ECONNREFUSED') return `Соединение отклонено (${where}). Проверьте адрес и порт.`;
  if (code === 'ETIMEDOUT' || /timed out/i.test(raw)) return 'Сервер не отвечает (таймаут).';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Сервер недоступен: нет маршрута до него.';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'Соединение сброшено.';
  if (e.level === 'client-authentication' || /authentication methods failed/i.test(raw)) {
    return 'Неверный логин, пароль или ключ.';
  }
  if (/host denied|verification failed/i.test(raw)) return 'Ключ сервера не принят — подключение отменено.';
  if (/Not connected|No response from server/i.test(raw)) return 'Нет соединения с сервером.';
  if (/Unable to request a pseudo-terminal/i.test(raw)) return 'Сервер не выдал терминал (pty).';
  if (/open failed|administratively prohibited/i.test(raw)) return 'Сервер запретил открыть канал (проверьте AllowTcpForwarding / MaxSessions).';

  // SFTP коды статуса.
  if (typeof code === 'number') {
    switch (code) {
      case 2: return 'Файл или папка не найдены.';
      case 3: return 'Нет прав доступа.';
      case 4: return raw && !/^Failure$/i.test(raw) ? `Ошибка на сервере: ${raw}` : 'Сервер не смог выполнить операцию (возможно, папка не пуста или нет прав).';
      case 5: return 'Сервер получил неверный запрос.';
      case 6: return 'Нет соединения с сервером.';
      case 7: return 'Соединение потеряно.';
      case 8: return 'Операция не поддерживается сервером.';
      default: break;
    }
  }
  return raw || 'Неизвестная ошибка.';
}

export function friendlyError(err: unknown, server?: Server): Error {
  if (err instanceof UserFacingError) return err;
  return new UserFacingError(friendlyMessage(err, server));
}

/** Делит вывод скрипта на секции по маркерам `@@NAME`. */
export function scriptSections(output: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('@@') && line.length > 2 && line !== '@@NOSYSTEMD') {
      current = line.slice(2);
      if (!result.has(current)) result.set(current, []);
      continue;
    }
    if (current === null || line.trim() === '') continue;
    result.get(current)!.push(line);
  }
  return result;
}
