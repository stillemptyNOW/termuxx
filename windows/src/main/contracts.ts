// Контракт между модулями main-процесса (ядро ↔ SSH-слой).
import type { BrowserWindow } from 'electron';
import type { AppData, OpenSessionRequest, Server, SessionStatusEvent, Settings, Snippet } from '../shared/types';

/** Хранилище данных и секретов (реализует src/main/store.ts). */
export interface StoreLike {
  data(): AppData;
  server(id: string): Server | undefined;
  snippet(id: string): Snippet | undefined;
  settings(): Settings;
  password(serverId: string): string | null;
  setPassword(serverId: string, password: string | null): void;
  proxyPassword(serverId: string): string | null;
  privateKey(keyId: string): string | null;          // PEM / OpenSSH
  passphrase(keyId: string): string | null;
  setPassphrase(keyId: string, passphrase: string | null): void;
  knownHost(hostPort: string): string | null;        // "host:port" -> "ssh-ed25519 SHA256:..."
  setKnownHost(hostPort: string, fingerprint: string): void;
  markConnected(serverId: string): void;
  saveServer(server: Server): void;
}

/** Общий контекст main-процесса. */
export interface MainContext {
  store: StoreLike;
  /** Отправить событие во все окна (renderer). */
  broadcast(channel: string, payload: unknown): void;
  mainWindow(): BrowserWindow | null;
}

/** Канал вывода конкретной сессии в UI. */
export interface SessionEmitter {
  data(text: string): void;
  status(e: Omit<SessionStatusEvent, 'sessionId'>): void;
}

/** Живая сессия (SSH, локальная оболочка или RDP). Управляется роутером сессий в main.ts. */
export interface SessionHandle {
  id: string;
  kind: 'ssh' | 'local' | 'rdp';
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): Promise<void> | void;
  remoteCwd?(): Promise<string | null>;
}

export type SshSessionRequest = Extract<OpenSessionRequest, { kind: 'ssh' }>;
export type LocalSessionRequest = Extract<OpenSessionRequest, { kind: 'local' }>;

// Экспорты модулей (имена фиксированы):
//   src/main/ssh/index.ts:
//     export function createSshSession(ctx: MainContext, req: SshSessionRequest, sessionId: string, emit: SessionEmitter): Promise<SessionHandle>
//     export function registerSshIpc(ctx: MainContext): void   // sftp:*, monitor:*, tunnel:*, key:install, prompt:* ответы
//     export function shutdownSsh(): Promise<void>
//   src/main/pty.ts:
//     export function listShells(): Promise<ShellInfo[]>
//     export function createPtySession(ctx: MainContext, req: LocalSessionRequest, sessionId: string, emit: SessionEmitter): Promise<SessionHandle>
