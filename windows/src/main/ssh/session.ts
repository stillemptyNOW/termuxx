// SSH-сессия терминала: подключение, оболочка с pty, вывод в UI, статусы, текущая папка.
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { ClientChannel } from 'ssh2';
import type { Server } from '../../shared/types';
import type { MainContext, SessionEmitter, SessionHandle, SshSessionRequest } from '../contracts';
import type { PromptBroker } from '../prompts';
import { SshConnection, connectServer } from './connect';
import { execCommand, friendlyMessage, serverLabel, sh, shQuote } from './util';

/** Хуки для модулей, которые живут вместе с сессией (SFTP, мониторинг, туннели). */
export interface SessionHooks {
  onConnected(session: SshSession): void;
  onClosed(session: SshSession): void;
}

const sessions = new Map<string, SshSession>();
/** Серверы, к которым в этом запуске уже открывали сессию (для «команды при входе» с tmux). */
const serversSeen = new Set<string>();

export function getSession(sessionId: string): SshSession | undefined {
  return sessions.get(sessionId);
}

/** Сессия с живым подключением, иначе понятная ошибка. */
export function requireSession(sessionId: string): SshSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Сессия не найдена.');
  if (!session.connection || !session.connection.isConnected) throw new Error('Сессия не подключена.');
  return session;
}

export function allSessions(): SshSession[] {
  return [...sessions.values()];
}

const OSC7 = /\x1b\]7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export class SshSession implements SessionHandle {
  readonly kind = 'ssh' as const;
  connection: SshConnection | null = null;
  channel: ClientChannel | null = null;
  readonly token = randomBytes(8).toString('hex');
  private decoder = new TextDecoder('utf-8');
  private pending: string[] = [];
  private pendingBytes = 0;
  private outBuffer = '';
  private outTimer: NodeJS.Timeout | null = null;
  private osc7Cwd: string | null = null;
  private exitCode: number | null = null;
  private exitSeen = false;
  private cleaned = false;
  private userClosed = false;
  private finished = false;
  private cols: number;
  private rows: number;
  /** Корневой ли пользователь на сервере (кешируется модулем мониторинга). */
  isRoot: boolean | null = null;
  /** Ресурсы, которые нужно освободить при закрытии (наблюдатели файлов и т.п.). */
  readonly disposers = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly server: Server,
    private readonly ctx: MainContext,
    private readonly broker: PromptBroker,
    private readonly emit: SessionEmitter,
    private readonly hooks: SessionHooks,
    private readonly request: SshSessionRequest,
  ) {
    this.cols = Math.max(2, request.cols | 0 || 80);
    this.rows = Math.max(2, request.rows | 0 || 24);
  }

  get connected(): boolean {
    return !!this.connection && this.connection.isConnected && !this.finished;
  }

  /** Запуск подключения (асинхронно, статусы уходят в emit). */
  start(): void {
    // Даём renderer'у получить sessionId раньше первых событий.
    setTimeout(() => void this.run(), 0);
  }

  private async run(): Promise<void> {
    const server = this.server;
    this.emit.status({ status: 'connecting', message: `Подключение к ${serverLabel(server)}…` });
    this.emit.data(`\x1b[2m→ Подключение к ${serverLabel(server)}…\x1b[0m\r\n`);

    let connection: SshConnection;
    try {
      connection = await connectServer(this.ctx, this.broker, server, { password: this.request.password });
    } catch (err) {
      const message = friendlyMessage(err, server);
      if (this.userClosed) return;
      this.finished = true;
      this.emit.data(`\r\n\x1b[31m✗ ${message.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
      this.emit.status({ status: 'error', message });
      sessions.delete(this.id);
      return;
    }
    if (this.userClosed) {
      connection.close();
      return;
    }
    this.connection = connection;
    connection.onClose((reason) => this.onConnectionClosed(reason));

    try {
      this.channel = await this.openShell(connection, !!server.x11);
    } catch (err) {
      if (server.x11) {
        // X11 запрещён на сервере — открываем обычную оболочку.
        this.emit.data('\x1b[33m⚠ Сервер не разрешил X11-форвардинг (X11Forwarding no) — продолжаем без него.\x1b[0m\r\n');
        try {
          this.channel = await this.openShell(connection, false);
        } catch (err2) {
          this.failAfterConnect(err2);
          return;
        }
      } else {
        this.failAfterConnect(err);
        return;
      }
    }

    const channel = this.channel!;
    channel.on('data', (buf: Buffer) => this.onOutput(buf));
    channel.stderr.on('data', (buf: Buffer) => this.onOutput(buf));
    channel.on('exit', (code: number | null) => {
      this.exitSeen = true;
      if (typeof code === 'number') this.exitCode = code;
    });
    // Решаем «штатный выход или обрыв» на следующем тике: при обрыве ssh2 сначала закрывает каналы,
    // а событие close клиента приходит чуть позже.
    channel.on('close', () => setImmediate(() => this.onChannelClosed()));

    if (server.x11) this.setupX11(connection);

    this.emit.data('\x1b[32m✓ Подключено\x1b[0m\r\n');
    this.emit.status({ status: 'connected' });

    // tmux и «команда при входе».
    const firstForServer = !serversSeen.has(server.id);
    serversSeen.add(server.id);
    if (server.useTmux) {
      channel.write(" printf '\\033[2J\\033[H'; if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s termuxx; else echo 'tmux не установлен: sudo apt install tmux'; fi\n");
    }
    const snippet = server.startupSnippetID ? this.ctx.store.snippet(server.startupSnippetID) : undefined;
    if (snippet && (!server.useTmux || firstForServer)) {
      channel.write(snippet.command + '\n');
    }
    // Ввод, набранный во время подключения.
    for (const data of this.pending) channel.write(data);
    this.pending = [];
    this.pendingBytes = 0;

    this.hooks.onConnected(this);
  }

  private openShell(connection: SshConnection, x11: boolean): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      try {
        connection.client.shell(
          { term: 'xterm-256color', cols: this.cols, rows: this.rows, width: 0, height: 0 },
          {
            env: { LANG: 'en_US.UTF-8', COLORTERM: 'truecolor', LC_TERMUXX: this.token },
            ...(x11 ? { x11: { single: false, screen: 0 } } : {}),
          },
          (err, channel) => (err ? reject(err) : resolve(channel)),
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  /** X11: соединения с сервера отправляем в локальный X-сервер (VcXsrv / Xming / X.Org) на :0. */
  private setupX11(connection: SshConnection): void {
    connection.client.on('x11', (_info, accept, reject) => {
      const local = net.connect(6000, '127.0.0.1');
      local.once('connect', () => {
        const stream = accept();
        stream.pipe(local).pipe(stream);
        const close = () => { try { stream.close(); } catch { /* ignore */ } local.destroy(); };
        stream.on('close', close);
        local.on('close', close);
        local.on('error', close);
      });
      local.once('error', () => {
        try { reject(); } catch { /* ignore */ }
        this.emit.data('\r\n\x1b[33m⚠ X11: не найден локальный X-сервер (запустите VcXsrv или Xming на :0).\x1b[0m\r\n');
      });
    });
  }

  private failAfterConnect(err: unknown): void {
    const message = friendlyMessage(err, this.server);
    this.finished = true;
    this.emit.data(`\r\n\x1b[31m✗ ${message}\x1b[0m\r\n`);
    this.emit.status({ status: 'error', message });
    this.connection?.close();
    this.cleanup();
  }

  private onOutput(buf: Buffer): void {
    const text = this.decoder.decode(buf, { stream: true });
    if (!text) return;
    if (text.includes('\x1b]7;')) {
      OSC7.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = OSC7.exec(text))) {
        try { this.osc7Cwd = decodeURIComponent(m[1]); } catch { this.osc7Cwd = m[1]; }
      }
    }
    // Склеиваем мелкие куски, чтобы не заваливать IPC.
    this.outBuffer += text;
    if (this.outBuffer.length > 64 * 1024) {
      this.flushOutput();
    } else if (!this.outTimer) {
      this.outTimer = setTimeout(() => this.flushOutput(), 4);
    }
  }

  private flushOutput(): void {
    if (this.outTimer) {
      clearTimeout(this.outTimer);
      this.outTimer = null;
    }
    if (!this.outBuffer) return;
    const chunk = this.outBuffer;
    this.outBuffer = '';
    this.emit.data(chunk);
  }

  private onChannelClosed(): void {
    if (this.finished) return;
    const tail = this.decoder.decode();
    if (tail) this.outBuffer += tail;
    this.flushOutput();
    // Штатный выход (exit/logout): сервер прислал код выхода и подключение ещё живо.
    const connectionAlive = !!this.connection && this.connection.isConnected;
    if (this.userClosed) {
      this.finish();
      return;
    }
    if (connectionAlive && this.exitSeen) {
      this.finished = true;
      this.emit.data('\r\n\x1b[2m— Сессия завершена —\x1b[0m\r\n');
      this.emit.status({ status: 'closed', exitCode: this.exitCode, dropped: false, message: 'Сессия завершена' });
      this.connection?.close();
      this.cleanup();
    } else {
      this.reportDropped(null);
    }
  }

  private onConnectionClosed(reason: string | null): void {
    if (this.finished || this.userClosed) {
      this.cleanup();
      return;
    }
    if (!this.channel) return; // ещё подключаемся — ошибку покажет run()
    this.flushOutput();
    this.reportDropped(reason);
  }

  private reportDropped(reason: string | null): void {
    if (this.finished) return;
    this.finished = true;
    const message = reason ? `Соединение потеряно: ${reason}` : 'Соединение потеряно';
    this.emit.data(`\r\n\x1b[33m⚠ ${message}\x1b[0m\r\n`);
    this.emit.status({ status: 'closed', dropped: true, exitCode: null, message });
    this.connection?.close();
    this.cleanup();
  }

  private finish(): void {
    if (!this.finished) {
      this.finished = true;
      this.emit.status({ status: 'closed', dropped: false, exitCode: this.exitCode, message: 'Отключено' });
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.outTimer) {
      clearTimeout(this.outTimer);
      this.outTimer = null;
    }
    for (const dispose of this.disposers) {
      try { dispose(); } catch { /* ignore */ }
    }
    this.disposers.clear();
    if (sessions.get(this.id) === this) sessions.delete(this.id);
    this.hooks.onClosed(this);
  }

  /** Служебная строка в терминал (предупреждения туннелей и т.п.). */
  notice(text: string): void {
    if (this.finished) return;
    this.flushOutput();
    this.emit.data(`\r\n${text}\r\n`);
  }

  // --- SessionHandle ---

  write(data: string): void {
    if (this.channel && !this.finished) {
      this.channel.write(data);
      return;
    }
    if (this.finished) return;
    // Набрано во время подключения — отправим после входа (не больше 64 КБ).
    if (this.pendingBytes + data.length <= 64 * 1024) {
      this.pending.push(data);
      this.pendingBytes += data.length;
    }
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(2, Math.floor(cols) || 0);
    const r = Math.max(2, Math.floor(rows) || 0);
    if (!c || !r) return;
    this.cols = c;
    this.rows = r;
    try {
      this.channel?.setWindow(r, c, 0, 0);
    } catch {
      // канал уже закрыт
    }
  }

  async close(): Promise<void> {
    if (this.userClosed) return;
    this.userClosed = true;
    try { this.channel?.end(); } catch { /* ignore */ }
    this.connection?.close();
    this.finish();
  }

  /** Текущая папка удалённой оболочки (OSC 7 → tmux → /proc). null, если не удалось. */
  async remoteCwd(): Promise<string | null> {
    if (this.osc7Cwd) return this.osc7Cwd;
    const connection = this.connection;
    if (!connection || !connection.isConnected) return null;
    const tok = shQuote(`LC_TERMUXX=${this.token}`);
    const script = [
      this.server.useTmux ? `p=$(tmux display-message -p -t termuxx '#{pane_current_path}' 2>/dev/null); if [ -n "$p" ]; then echo "$p"; exit 0; fi` : ':',
      `pid=$(grep -lasF ${tok} /proc/[0-9]*/environ 2>/dev/null | sed 's#/proc/##; s#/environ##' | sort -n | head -n 1)`,
      `[ -z "$pid" ] && exit 1`,
      `fg=$(sed 's/.*) //' /proc/$pid/stat 2>/dev/null | awk '{print $6}')`,
      `if [ -n "$fg" ] && [ "$fg" -gt 0 ] 2>/dev/null; then d=$(readlink /proc/$fg/cwd 2>/dev/null); fi`,
      `[ -z "$d" ] && d=$(readlink /proc/$pid/cwd 2>/dev/null)`,
      `[ -n "$d" ] && echo "$d"`,
    ].join('\n');
    try {
      const { output } = await execCommand(connection.client, sh(script), { timeoutMs: 8000, maxBytes: 64 * 1024 });
      const line = output.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/'));
      return line ?? null;
    } catch {
      return null;
    }
  }
}

/** Создать SSH-сессию: возвращается сразу, подключение идёт в фоне (статусы — через emit). */
export function createSession(
  ctx: MainContext,
  broker: PromptBroker,
  hooks: SessionHooks,
  req: SshSessionRequest,
  sessionId: string,
  emit: SessionEmitter,
): SshSession {
  const server = ctx.store.server(req.serverId);
  if (!server) throw new Error('Сервер не найден. Возможно, он был удалён.');
  const session = new SshSession(sessionId, server, ctx, broker, emit, hooks, req);
  sessions.set(sessionId, session);
  session.start();
  return session;
}

/** Найти открытую сессию с живым подключением к этому серверу. */
export function findConnectedSession(serverId: string): SshSession | undefined {
  for (const s of sessions.values()) {
    if (s.server.id === serverId && s.connected) return s;
  }
  return undefined;
}

export async function closeAllSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => s.close().catch(() => undefined)));
  sessions.clear();
}
