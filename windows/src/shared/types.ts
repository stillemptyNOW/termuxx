// Общая модель данных Termuxx для Windows.
// JSON-поля совпадают с iOS/Linux (camelCase), поэтому бэкапы переносятся между платформами
// (см. docs/BACKUP_FORMAT.md). Неизвестные поля при чтении сохраняются как есть.

export type UUID = string; // верхний регистр, как в Swift

export type AuthMethod = 'password' | 'key' | 'agent';

export type SessionProtocol = 'ssh' | 'rdp' | 'telnet';

export interface ProxyConfig {
  host: string;
  port: number;
  username: string;
}

export type ForwardType = 'local' | 'remote' | 'dynamic';

export interface PortForward {
  id: UUID;
  name: string;
  /** iOS/Linux знают только local; поле необязательно для совместимости. */
  type?: ForwardType;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface Server {
  id: UUID;
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyID?: UUID | null;
  startupSnippetID?: UUID | null;
  colorHex: string;
  lastConnected?: string | null; // ISO8601
  useTmux: boolean;
  autoReconnect: boolean;
  keepAlive: boolean;
  jumpHostID?: UUID | null;
  proxy?: ProxyConfig | null;
  forwards: PortForward[];
  // Только Windows (другие платформы игнорируют):
  group?: string | null;          // папка в дереве сессий
  protocol?: SessionProtocol;     // по умолчанию 'ssh'
  x11?: boolean;                  // X11-форвардинг (нужен внешний X-сервер, например VcXsrv)
  followTerminalFolder?: boolean; // SFTP-панель следует за папкой терминала
  notes?: string;
}

export interface SSHKeyItem {
  id: UUID;
  name: string;
  type: string;      // "ED25519" | "RSA" | "ECDSA"
  publicKey: string;
  created: string;   // ISO8601
  encrypted?: boolean | null;
}

export interface Snippet {
  id: UUID;
  name: string;
  command: string;
  runImmediately: boolean;
}

export type CursorStyle = 'block' | 'bar' | 'underline';

export interface Settings {
  themeID: string;            // id из THEMES
  fontFamily: string;         // "JetBrains Mono" | "IBM Plex Mono" | "Cascadia Mono" | "Consolas" | ...
  fontSize: number;           // px
  lineHeight: number;         // 1.0–1.6
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;   // как в MobaXterm/PuTTY
  confirmCloseTab: boolean;
  defaultShellID: string | null; // id из ShellInfo
  sftpFollowsTerminal: boolean;
  showRemoteMonitorBar: boolean; // строка CPU/RAM/диск снизу, как в MobaXterm
  backgroundMaterial: 'mica' | 'acrylic' | 'none';
  accentHex: string;
  bellSound: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  themeID: 'termuxx',
  fontFamily: 'JetBrains Mono',
  fontSize: 14,
  lineHeight: 1.15,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClickPaste: true,
  confirmCloseTab: true,
  defaultShellID: null,
  sftpFollowsTerminal: true,
  showRemoteMonitorBar: true,
  backgroundMaterial: 'mica',
  accentHex: '#3DDC97',
  bellSound: false,
};

/** Снимок всех данных (без секретов). */
export interface AppData {
  hosts: Server[];
  keys: SSHKeyItem[];
  snippets: Snippet[];
  knownHosts: Record<string, string>; // "host:port" -> "ssh-ed25519 SHA256:..."
  settings: Settings;
}

/** Локальная оболочка Windows (или Linux при разработке). */
export interface ShellInfo {
  id: string;        // "pwsh" | "powershell" | "cmd" | "wsl:Ubuntu" | "gitbash" | "bash" ...
  name: string;      // «PowerShell 7», «Командная строка», «WSL: Ubuntu», «Git Bash»
  command: string;
  args: string[];
  icon: 'powershell' | 'cmd' | 'linux' | 'git' | 'terminal';
}

// ---------- Сессии ----------

export type SessionKind = 'ssh' | 'local' | 'rdp';

export type OpenSessionRequest =
  | { kind: 'ssh'; serverId: UUID; password?: string; cols: number; rows: number }
  | { kind: 'local'; shellId: string; cwd?: string; cols: number; rows: number }
  | { kind: 'rdp'; serverId: UUID };

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error';

export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  message?: string;       // человекочитаемо, по-русски
  exitCode?: number | null;
  /** true, если обрыв (а не штатный выход) — UI предложит переподключиться. */
  dropped?: boolean;
}

export interface SessionDataEvent {
  sessionId: string;
  data: string; // UTF-8 текст для xterm.write
}

// ---------- Запросы к пользователю (main → renderer → main) ----------

export interface HostKeyPrompt {
  requestId: string;
  serverId: UUID | null;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;      // "SHA256:..."
  changed: boolean;         // true — ключ ИЗМЕНИЛСЯ (возможна подмена)
  previous?: string | null;
}

export interface AuthPrompt {
  requestId: string;
  serverId: UUID | null;
  title: string;            // «Пароль для root@1.2.3.4»
  kind: 'password' | 'passphrase' | 'keyboard-interactive';
  prompts: { prompt: string; echo: boolean }[];
  canRemember: boolean;
}

export interface AuthAnswer {
  answers: string[] | null; // null — отмена
  remember: boolean;
}

// ---------- SFTP ----------

export interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mtime: number;            // unix seconds
  mode: number;             // права (st_mode)
  owner?: string;
}

export interface TransferProgress {
  transferId: string;
  sessionId: string;
  direction: 'download' | 'upload';
  name: string;             // текущий файл
  done: number;             // байт
  total: number;            // байт (0 — неизвестно)
  files: number;
  filesDone: number;
  speed: number;            // байт/с
  state: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
}

// ---------- Мониторинг ----------

export interface MonitorSnapshot {
  hostname: string;
  os: string;
  kernel: string;
  uptime: number;                 // секунды
  load: [number, number, number];
  cores: number;
  cpu: number;                    // 0–100
  memTotal: number;               // байт
  memAvailable: number;
  swapTotal: number;
  swapFree: number;
  disks: { mount: string; size: number; used: number }[];
  netRx: number;                  // байт/с
  netTx: number;
  processes: { pid: number; name: string; cpu: number; mem: number }[];
  time: number;                   // ms epoch
}

export interface ServiceInfo {
  name: string;
  active: string;   // active/inactive/failed
  sub: string;      // running/exited/dead
  description: string;
}

export interface ContainerInfo {
  name: string;
  status: string;
  image: string;
  running: boolean;
}

// ---------- Туннели ----------

export interface TunnelState {
  id: string;               // = forward.id
  serverId: UUID;
  sessionId: string | null;
  forward: PortForward;
  status: 'starting' | 'active' | 'error' | 'stopped';
  connections: number;
  bytesIn: number;
  bytesOut: number;
  error?: string;
}

// ---------- Бэкап ----------

export interface BackupPreview {
  app: string;
  createdAt: string;
  hosts: number;
  keys: number;
  snippets: number;
  knownHosts: number;
  hasSecrets: boolean;
}

export interface ImportSummary {
  lines: string[];
  warnings: string[];
}
