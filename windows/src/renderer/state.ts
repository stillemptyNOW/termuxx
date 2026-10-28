// Состояние рабочей области Termuxx (zustand).
import { create } from 'zustand';
import type {
  AppData, ImportSummary, Server, SessionStatus, Settings, ShellInfo,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

export type PaneKind = 'ssh' | 'local';
export type SplitDir = 'none' | 'row' | 'column';

export interface Pane {
  id: string;
  kind: PaneKind;
  serverId?: string;
  shellId?: string;
  sessionId: string | null;
  status: SessionStatus | 'idle';
  message?: string;
  dropped?: boolean;
  /** Заголовок из OSC 0/2 (xterm onTitleChange). */
  title?: string;
  reconnectAttempt: number;
}

export interface Tab {
  id: string;
  kind: PaneKind;
  serverId?: string;
  shellId?: string;
  title: string;
  panes: Pane[];
  split: SplitDir;
  activePaneId: string;
  /** Отмечена для MultiExec. */
  multiExec: boolean;
  sftpOpen: boolean;
  bell: boolean;
}

export type SettingsSection = 'appearance' | 'terminal' | 'keys' | 'snippets' | 'backup' | 'about';

export type DialogState =
  | { type: 'server'; serverId?: string; initial?: Partial<Server> }
  | { type: 'settings'; section?: SettingsSection }
  | { type: 'monitor'; sessionId: string; serverId: string }
  | { type: 'tunnels'; sessionId: string; serverId: string }
  | { type: 'palette' }
  | { type: 'summary'; title: string; summary: ImportSummary }
  | { type: 'confirm'; title: string; text: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }
  | { type: 'prompt'; title: string; label: string; value: string; suggestions?: string[]; onSubmit: (v: string) => void }
  | null;

export interface LayoutPrefs {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  sftpWidth: number;
  collapsedGroups: string[];
  recentQuick: string[];
}

const LAYOUT_KEY = 'termuxx.layout.v1';

const DEFAULT_LAYOUT: LayoutPrefs = {
  sidebarWidth: 270,
  sidebarCollapsed: false,
  sftpWidth: 320,
  collapsedGroups: [],
  recentQuick: [],
};

function loadLayout(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<LayoutPrefs>) };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function saveLayout(layout: LayoutPrefs) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* приватный режим — не страшно */ }
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export function newUUID(): string {
  try {
    return crypto.randomUUID().toUpperCase();
  } catch {
    const s = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1).toUpperCase();
    return `${s()}${s()}-${s()}-4${s().slice(1)}-${s()}-${s()}${s()}${s()}`;
  }
}

function makePane(kind: PaneKind, serverId?: string, shellId?: string): Pane {
  return { id: uid('pane'), kind, serverId, shellId, sessionId: null, status: 'idle', reconnectAttempt: 0 };
}

export interface PaneLocation { tab: Tab; pane: Pane }

export interface AppState {
  data: AppData | null;
  loadError: string | null;
  shells: ShellInfo[];
  tabs: Tab[];
  activeTabId: string | null;
  multiExec: boolean;
  layout: LayoutPrefs;
  dialog: DialogState;
  /** Открыть инструмент, когда панель подключится. */
  pendingTool: { paneId: string; tool: 'monitor' | 'tunnels' } | null;
  windowState: { maximized: boolean; fullscreen: boolean; focused: boolean };
  /** Пока жмут «Найти» — id панели с открытой строкой поиска. */
  searchPaneId: string | null;

  setData(data: AppData): void;
  setLoadError(err: string | null): void;
  setShells(shells: ShellInfo[]): void;
  settings(): Settings;
  server(id: string | undefined | null): Server | undefined;

  openServerTab(server: Server, opts?: { sftp?: boolean; tool?: 'monitor' | 'tunnels' }): string;
  openShellTab(shell: ShellInfo): string;
  closeTab(tabId: string): void;
  activateTab(tabId: string | null): void;
  moveTab(fromId: string, toId: string): void;
  renameTab(tabId: string, title: string): void;
  splitActive(dir: 'row' | 'column'): void;
  closePane(paneId: string): void;
  focusPane(tabId: string, paneId: string): void;
  updatePane(paneId: string, patch: Partial<Pane>): void;
  findPane(paneId: string): PaneLocation | undefined;
  findPaneBySession(sessionId: string): PaneLocation | undefined;
  toggleSftp(tabId?: string): void;
  setTabFlag(tabId: string, patch: Partial<Pick<Tab, 'multiExec' | 'bell' | 'sftpOpen'>>): void;
  setMultiExec(on: boolean): void;
  setLayout(patch: Partial<LayoutPrefs>): void;
  setDialog(d: DialogState): void;
  setPendingTool(p: AppState['pendingTool']): void;
  setWindowState(s: AppState['windowState']): void;
  setSearchPane(id: string | null): void;
  rememberQuick(text: string): void;
}

export const useApp = create<AppState>((set, get) => ({
  data: null,
  loadError: null,
  shells: [],
  tabs: [],
  activeTabId: null,
  multiExec: false,
  layout: loadLayout(),
  dialog: null,
  pendingTool: null,
  windowState: { maximized: false, fullscreen: false, focused: true },
  searchPaneId: null,

  setData: (data) => set({ data: { ...data, settings: { ...DEFAULT_SETTINGS, ...data.settings } } }),
  setLoadError: (loadError) => set({ loadError }),
  setShells: (shells) => set({ shells }),
  settings: () => get().data?.settings ?? DEFAULT_SETTINGS,
  server: (id) => (id ? get().data?.hosts.find((h) => h.id === id) : undefined),

  openServerTab: (server, opts) => {
    const pane = makePane('ssh', server.id);
    const tab: Tab = {
      id: uid('tab'),
      kind: 'ssh',
      serverId: server.id,
      title: server.name || server.hostname,
      panes: [pane],
      split: 'none',
      activePaneId: pane.id,
      multiExec: false,
      sftpOpen: opts?.sftp ?? true,
      bell: false,
    };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      pendingTool: opts?.tool ? { paneId: pane.id, tool: opts.tool } : s.pendingTool,
    }));
    return tab.id;
  },

  openShellTab: (shell) => {
    const pane = makePane('local', undefined, shell.id);
    const tab: Tab = {
      id: uid('tab'),
      kind: 'local',
      shellId: shell.id,
      title: shell.name,
      panes: [pane],
      split: 'none',
      activePaneId: pane.id,
      multiExec: false,
      sftpOpen: false,
      bell: false,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  closeTab: (tabId) => set((s) => {
    const idx = s.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return {};
    const tabs = s.tabs.filter((t) => t.id !== tabId);
    let activeTabId = s.activeTabId;
    if (activeTabId === tabId) {
      const next = tabs[idx] ?? tabs[idx - 1];
      activeTabId = next ? next.id : null;
    }
    return { tabs, activeTabId, multiExec: tabs.length > 1 ? s.multiExec : false };
  }),

  activateTab: (activeTabId) => set((s) => ({
    activeTabId,
    tabs: s.tabs.map((t) => (t.id === activeTabId && t.bell ? { ...t, bell: false } : t)),
  })),

  moveTab: (fromId, toId) => set((s) => {
    if (fromId === toId) return {};
    const tabs = [...s.tabs];
    const from = tabs.findIndex((t) => t.id === fromId);
    const to = tabs.findIndex((t) => t.id === toId);
    if (from < 0 || to < 0) return {};
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    return { tabs };
  }),

  renameTab: (tabId, title) => set((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
  })),

  splitActive: (dir) => set((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab || tab.panes.length >= 4) return {};
    const pane = makePane(tab.kind, tab.serverId, tab.shellId);
    return {
      tabs: s.tabs.map((t) => (t.id === tab.id
        ? { ...t, panes: [...t.panes, pane], split: dir, activePaneId: pane.id }
        : t)),
    };
  }),

  closePane: (paneId) => {
    const loc = get().findPane(paneId);
    if (!loc) return;
    if (loc.tab.panes.length <= 1) {
      get().closeTab(loc.tab.id);
      return;
    }
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== loc.tab.id) return t;
        const panes = t.panes.filter((p) => p.id !== paneId);
        return {
          ...t,
          panes,
          split: panes.length > 1 ? t.split : 'none',
          activePaneId: t.activePaneId === paneId ? panes[panes.length - 1].id : t.activePaneId,
        };
      }),
    }));
  },

  focusPane: (tabId, paneId) => set((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId && t.activePaneId !== paneId ? { ...t, activePaneId: paneId } : t)),
  })),

  updatePane: (paneId, patch) => set((s) => ({
    tabs: s.tabs.map((t) => {
      if (!t.panes.some((p) => p.id === paneId)) return t;
      return { ...t, panes: t.panes.map((p) => (p.id === paneId ? { ...p, ...patch } : p)) };
    }),
  })),

  findPane: (paneId) => {
    for (const tab of get().tabs) {
      const pane = tab.panes.find((p) => p.id === paneId);
      if (pane) return { tab, pane };
    }
    return undefined;
  },

  findPaneBySession: (sessionId) => {
    for (const tab of get().tabs) {
      const pane = tab.panes.find((p) => p.sessionId === sessionId);
      if (pane) return { tab, pane };
    }
    return undefined;
  },

  toggleSftp: (tabId) => set((s) => {
    const id = tabId ?? s.activeTabId;
    return { tabs: s.tabs.map((t) => (t.id === id && t.kind === 'ssh' ? { ...t, sftpOpen: !t.sftpOpen } : t)) };
  }),

  setTabFlag: (tabId, patch) => set((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  })),

  setMultiExec: (multiExec) => set((s) => ({
    multiExec,
    // при включении отмечаем все вкладки — как в MobaXterm
    tabs: multiExec ? s.tabs.map((t) => ({ ...t, multiExec: true })) : s.tabs,
  })),

  setLayout: (patch) => set((s) => {
    const layout = { ...s.layout, ...patch };
    saveLayout(layout);
    return { layout };
  }),

  setDialog: (dialog) => set({ dialog }),
  setPendingTool: (pendingTool) => set({ pendingTool }),
  setWindowState: (windowState) => set({ windowState }),
  setSearchPane: (searchPaneId) => set({ searchPaneId }),

  rememberQuick: (text) => set((s) => {
    const recentQuick = [text, ...s.layout.recentQuick.filter((x) => x !== text)].slice(0, 8);
    const layout = { ...s.layout, recentQuick };
    saveLayout(layout);
    return { layout };
  }),
}));

/** Активная вкладка и её активная панель. */
export function activeLocation(s: AppState = useApp.getState()): PaneLocation | undefined {
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!tab) return undefined;
  const pane = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0];
  return pane ? { tab, pane } : undefined;
}

/** Разбор строки быстрого подключения: [ssh] [user@]host[:port] [-p port]. */
export function parseQuickConnect(raw: string): { username: string; hostname: string; port: number } | null {
  let text = raw.trim();
  if (!text) return null;
  if (text.toLowerCase().startsWith('ssh ')) text = text.slice(4).trim();
  let port = 22;
  const pMatch = text.match(/\s-p\s*(\d{1,5})/);
  if (pMatch) {
    port = Number(pMatch[1]);
    text = text.replace(pMatch[0], '').trim();
  }
  text = text.split(/\s+/)[0] ?? '';
  let username = 'root';
  const at = text.lastIndexOf('@');
  if (at >= 0) {
    username = text.slice(0, at) || 'root';
    text = text.slice(at + 1);
  }
  // [ipv6]:port
  const v6 = text.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (v6) {
    text = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else {
    const colon = text.lastIndexOf(':');
    if (colon > 0 && text.indexOf(':') === colon) {
      const p = Number(text.slice(colon + 1));
      if (Number.isInteger(p) && p > 0 && p < 65536) {
        port = p;
        text = text.slice(0, colon);
      }
    }
  }
  if (!text || !/^[\w.\-:%]+$/.test(text)) return null;
  if (!(port > 0 && port < 65536)) return null;
  return { username, hostname: text, port };
}

export function blankServer(patch: Partial<Server> = {}): Server {
  return {
    id: newUUID(),
    name: '',
    hostname: '',
    port: 22,
    username: 'root',
    auth: 'password',
    keyID: null,
    startupSnippetID: null,
    colorHex: '#3DDC97',
    lastConnected: null,
    useTmux: false,
    autoReconnect: true,
    keepAlive: true,
    jumpHostID: null,
    proxy: null,
    forwards: [],
    group: null,
    protocol: 'ssh',
    x11: false,
    followTerminalFolder: true,
    notes: '',
    ...patch,
  };
}

export const SERVER_COLORS = ['#3DDC97', '#4EA8FF', '#B48CFF', '#FF7AA2', '#FFB454', '#FF5C5C', '#5CE1E6', '#C7D0DA'];

export function sshCommand(server: Server, jump?: Server): string {
  const parts = ['ssh'];
  if (server.port && server.port !== 22) parts.push('-p', String(server.port));
  if (jump) parts.push('-J', `${jump.username}@${jump.hostname}${jump.port !== 22 ? `:${jump.port}` : ''}`);
  parts.push(`${server.username}@${server.hostname}`);
  return parts.join(' ');
}

export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
