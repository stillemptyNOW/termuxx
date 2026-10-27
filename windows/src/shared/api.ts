// Контракт между процессами Electron. preload реализует TermuxxAPI через ipcRenderer,
// main регистрирует обработчики с теми же именами каналов (IPC.*).
import type {
  AppData, AuthAnswer, AuthPrompt, BackupPreview, ContainerInfo, HostKeyPrompt, ImportSummary,
  MonitorSnapshot, OpenSessionRequest, PortForward, RemoteEntry, Server, ServiceInfo, SessionDataEvent,
  SessionStatusEvent, Settings, ShellInfo, Snippet, SSHKeyItem, TransferProgress, TunnelState, UUID,
} from './types';

export type Unsubscribe = () => void;

export interface TermuxxAPI {
  platform: 'win32' | 'linux' | 'darwin';
  version: string;

  // --- данные ---
  loadData(): Promise<AppData>;
  saveServer(server: Server): Promise<void>;
  deleteServer(id: UUID): Promise<void>;
  saveSnippet(snippet: Snippet): Promise<void>;
  deleteSnippet(id: UUID): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
  forgetHostKey(hostPort: string): Promise<void>;
  /** Срабатывает после любого изменения данных (в том числе из другого окна/импорта). */
  onDataChanged(cb: (data: AppData) => void): Unsubscribe;

  // --- секреты (шифруются через Electron safeStorage / DPAPI) ---
  hasPassword(serverId: UUID): Promise<boolean>;
  setPassword(serverId: UUID, password: string | null): Promise<void>;
  setProxyPassword(serverId: UUID, password: string | null): Promise<void>;

  // --- ключи ---
  generateKey(name: string, passphrase?: string): Promise<SSHKeyItem>;
  importKey(name: string, pem: string, passphrase?: string): Promise<SSHKeyItem>; // бросает понятную ошибку
  importKeyFile(): Promise<SSHKeyItem | null>;                                     // диалог выбора файла
  deleteKey(id: UUID): Promise<void>;
  installKey(keyId: UUID, serverId: UUID): Promise<string>;                        // вывод сервера

  // --- оболочки и сессии ---
  listShells(): Promise<ShellInfo[]>;
  openSession(req: OpenSessionRequest): Promise<{ sessionId: string }>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  closeSession(sessionId: string): Promise<void>;
  /** Текущая папка удалённой оболочки (через отдельный exec или OSC 7) — для SFTP-панели. */
  remoteCwd(sessionId: string): Promise<string | null>;
  onSessionData(cb: (e: SessionDataEvent) => void): Unsubscribe;
  onSessionStatus(cb: (e: SessionStatusEvent) => void): Unsubscribe;

  // --- запросы к пользователю ---
  onHostKeyPrompt(cb: (p: HostKeyPrompt) => void): Unsubscribe;
  answerHostKey(requestId: string, accept: boolean): void;
  onAuthPrompt(cb: (p: AuthPrompt) => void): Unsubscribe;
  answerAuth(requestId: string, answer: AuthAnswer): void;

  // --- SFTP (поверх SSH-подключения сессии) ---
  sftpHome(sessionId: string): Promise<string>;
  sftpList(sessionId: string, path: string): Promise<RemoteEntry[]>;
  sftpMkdir(sessionId: string, path: string): Promise<void>;
  sftpRename(sessionId: string, from: string, to: string): Promise<void>;
  sftpDelete(sessionId: string, paths: string[]): Promise<void>;            // рекурсивно
  sftpChmod(sessionId: string, path: string, mode: number): Promise<void>;
  sftpReadText(sessionId: string, path: string): Promise<string>;          // до 5 МБ
  sftpWriteText(sessionId: string, path: string, text: string): Promise<void>;
  sftpDownload(sessionId: string, remotePaths: string[], localDir?: string): Promise<string>; // transferId; без localDir — диалог
  sftpUpload(sessionId: string, remoteDir: string, localPaths?: string[]): Promise<string>;  // без localPaths — диалог
  /** Открыть во внешнем редакторе; изменения автоматически загружаются обратно (как в MobaXterm). */
  sftpOpenExternal(sessionId: string, remotePath: string): Promise<void>;
  cancelTransfer(transferId: string): void;
  onTransfer(cb: (p: TransferProgress) => void): Unsubscribe;

  // --- мониторинг ---
  monitorStart(sessionId: string, intervalMs?: number): void;
  monitorStop(sessionId: string): void;
  onMonitor(cb: (e: { sessionId: string; snapshot: MonitorSnapshot | null; error?: string }) => void): Unsubscribe;
  listServices(sessionId: string): Promise<ServiceInfo[]>;
  listContainers(sessionId: string): Promise<ContainerInfo[]>;
  serviceAction(sessionId: string, name: string, action: 'restart' | 'start' | 'stop' | 'logs'): Promise<string>;
  containerAction(sessionId: string, name: string, action: 'restart' | 'start' | 'stop' | 'logs'): Promise<string>;

  // --- туннели ---
  tunnelStart(sessionId: string, forward: PortForward): Promise<void>;
  tunnelStop(forwardId: string): Promise<void>;
  tunnelList(): Promise<TunnelState[]>;
  onTunnels(cb: (list: TunnelState[]) => void): Unsubscribe;

  // --- бэкап ---
  backupExport(includeSecrets: boolean, password?: string): Promise<string | null>; // путь или null (отмена)
  backupInspect(): Promise<{ path: string; preview: BackupPreview } | null>;        // диалог выбора файла
  backupImport(path: string, password?: string): Promise<ImportSummary>;
  importSshConfig(): Promise<ImportSummary>;   // ~/.ssh/config → серверы
  importPutty(): Promise<ImportSummary>;       // сессии PuTTY из реестра (только Windows)

  // --- окно и система ---
  openExternal(url: string): void;
  showItemInFolder(path: string): void;
  clipboardRead(): string;
  clipboardWrite(text: string): void;
  windowControl(action: 'minimize' | 'maximize' | 'close' | 'fullscreen'): void;
  onWindowState(cb: (s: { maximized: boolean; fullscreen: boolean; focused: boolean }) => void): Unsubscribe;
}

/** Имена IPC-каналов. invoke — для промисов, send — для событий без ответа. */
export const IPC = {
  loadData: 'data:load',
  saveServer: 'data:saveServer',
  deleteServer: 'data:deleteServer',
  saveSnippet: 'data:saveSnippet',
  deleteSnippet: 'data:deleteSnippet',
  saveSettings: 'data:saveSettings',
  forgetHostKey: 'data:forgetHostKey',
  dataChanged: 'data:changed',

  hasPassword: 'secret:hasPassword',
  setPassword: 'secret:setPassword',
  setProxyPassword: 'secret:setProxyPassword',

  generateKey: 'key:generate',
  importKey: 'key:import',
  importKeyFile: 'key:importFile',
  deleteKey: 'key:delete',
  installKey: 'key:install',

  listShells: 'session:listShells',
  openSession: 'session:open',
  write: 'session:write',
  resize: 'session:resize',
  closeSession: 'session:close',
  remoteCwd: 'session:remoteCwd',
  sessionData: 'session:data',
  sessionStatus: 'session:status',

  hostKeyPrompt: 'prompt:hostKey',
  hostKeyAnswer: 'prompt:hostKeyAnswer',
  authPrompt: 'prompt:auth',
  authAnswer: 'prompt:authAnswer',

  sftpHome: 'sftp:home',
  sftpList: 'sftp:list',
  sftpMkdir: 'sftp:mkdir',
  sftpRename: 'sftp:rename',
  sftpDelete: 'sftp:delete',
  sftpChmod: 'sftp:chmod',
  sftpReadText: 'sftp:readText',
  sftpWriteText: 'sftp:writeText',
  sftpDownload: 'sftp:download',
  sftpUpload: 'sftp:upload',
  sftpOpenExternal: 'sftp:openExternal',
  cancelTransfer: 'sftp:cancel',
  transfer: 'sftp:transfer',

  monitorStart: 'monitor:start',
  monitorStop: 'monitor:stop',
  monitor: 'monitor:snapshot',
  listServices: 'monitor:services',
  listContainers: 'monitor:containers',
  serviceAction: 'monitor:serviceAction',
  containerAction: 'monitor:containerAction',

  tunnelStart: 'tunnel:start',
  tunnelStop: 'tunnel:stop',
  tunnelList: 'tunnel:list',
  tunnels: 'tunnel:changed',

  backupExport: 'backup:export',
  backupInspect: 'backup:inspect',
  backupImport: 'backup:import',
  importSshConfig: 'import:sshConfig',
  importPutty: 'import:putty',

  openExternal: 'sys:openExternal',
  showItemInFolder: 'sys:showItemInFolder',
  clipboardRead: 'sys:clipboardRead',
  clipboardWrite: 'sys:clipboardWrite',
  windowControl: 'win:control',
  windowState: 'win:state',
} as const;

declare global {
  interface Window {
    termuxx: TermuxxAPI;
  }
}
