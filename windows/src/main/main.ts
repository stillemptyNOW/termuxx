// Termuxx для Windows — главный процесс Electron.
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IPC } from '../shared/api';
import type { OpenSessionRequest, SessionStatusEvent, Settings } from '../shared/types';
import type { MainContext, SessionEmitter, SessionHandle } from './contracts';
import { isSafeExternal, registerCoreIpc } from './ipc-core';
import { createPtySession, listShells } from './pty';
import { openRdpSession } from './rdp';
import { createSshSession, registerSshIpc, shutdownSsh } from './ssh';
import { Store } from './store';

const SMOKE = process.argv.includes('--smoke-test');
const isWin = process.platform === 'win32';
const APP_ID = 'com.stillempty.termuxx';

function smokeFail(reason: string): void {
  if (!SMOKE) return;
  process.stderr.write(`SMOKE FAIL: ${reason}\n`);
  app.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
  smokeFail(`uncaught exception: ${err?.stack ?? err}`);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
  smokeFail(`unhandled rejection: ${(reason as Error)?.stack ?? reason}`);
});

if (SMOKE) {
  // Смоук-тест не трогает настоящие данные пользователя и не мешает уже открытому окну.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'termuxx-smoke-')));
  setTimeout(() => smokeFail('timeout 30s'), 30_000).unref();
} else {
  // Один и тот же каталог данных в разработке и в установленной версии: %APPDATA%\Termuxx.
  app.setPath('userData', path.join(app.getPath('appData'), 'Termuxx'));
  if (!app.requestSingleInstanceLock()) app.quit();
}

if (isWin) app.setAppUserModelId(APP_ID);
app.setName('Termuxx');
nativeTheme.themeSource = 'dark';
Menu.setApplicationMenu(null);

const store = new Store();
let mainWindow: BrowserWindow | null = null;

const ctx: MainContext = {
  store,
  broadcast(channel, payload) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
    }
  },
  mainWindow: () => mainWindow,
};

// ---------- сессии ----------

const sessions = new Map<string, { handle: SessionHandle; emitter: BufferedEmitter }>();
let sessionSeq = 0;

type QueuedEvent = { kind: 'data'; text: string } | { kind: 'status'; e: Omit<SessionStatusEvent, 'sessionId'> };

/**
 * Эмиттер сессии: склеивает вывод терминала (сброс раз в ~8 мс) и придерживает события,
 * пока renderer не получил sessionId (ответ на session:open уходит раньше первых данных).
 */
class BufferedEmitter implements SessionEmitter {
  private held = true;
  private queue: QueuedEvent[] = [];
  private pending = '';
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly sessionId: string, private readonly wc: Electron.WebContents) {}

  data(text: string): void {
    if (this.disposed || !text) return;
    if (this.held) {
      const last = this.queue[this.queue.length - 1];
      if (last && last.kind === 'data') last.text += text; else this.queue.push({ kind: 'data', text });
      return;
    }
    this.pending += text;
    if (this.pending.length > 256 * 1024) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 8);
  }

  status(e: Omit<SessionStatusEvent, 'sessionId'>): void {
    if (this.disposed) return;
    if (this.held) {
      this.queue.push({ kind: 'status', e });
      return;
    }
    this.flush();
    this.send(IPC.sessionStatus, { sessionId: this.sessionId, ...e });
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    for (const item of this.queue) {
      if (item.kind === 'data') this.send(IPC.sessionData, { sessionId: this.sessionId, data: item.text });
      else this.send(IPC.sessionStatus, { sessionId: this.sessionId, ...item.e });
    }
    this.queue = [];
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending) return;
    const data = this.pending;
    this.pending = '';
    this.send(IPC.sessionData, { sessionId: this.sessionId, data });
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }

  private send(channel: string, payload: unknown): void {
    if (this.wc.isDestroyed()) return;
    this.wc.send(channel, payload);
  }
}

function registerSessionIpc(): void {
  ipcMain.handle(IPC.listShells, () => listShells());

  ipcMain.handle(IPC.openSession, async (event, req: OpenSessionRequest) => {
    if (!req || typeof req !== 'object') throw new Error('Некорректный запрос сессии.');
    const prefix = req.kind === 'ssh' ? 'ssh' : req.kind === 'local' ? 'pty' : req.kind === 'rdp' ? 'rdp' : '';
    if (!prefix) throw new Error('Неизвестный тип сессии.');
    const sessionId = `${prefix}-${++sessionSeq}`;
    const emitter = new BufferedEmitter(sessionId, event.sender);
    let handle: SessionHandle;
    switch (req.kind) {
      case 'ssh':
        handle = await createSshSession(ctx, req, sessionId, emitter);
        break;
      case 'local':
        handle = await createPtySession(ctx, req, sessionId, emitter);
        break;
      case 'rdp':
        handle = await openRdpSession(ctx, req, sessionId, emitter);
        break;
      default:
        throw new Error('Неизвестный тип сессии.');
    }
    sessions.set(sessionId, { handle, emitter });
    // Ответ на invoke уйдёт раньше, чем события из setImmediate — renderer уже будет знать id.
    setImmediate(() => emitter.release());
    return { sessionId };
  });

  ipcMain.on(IPC.write, (_e, sessionId: string, data: string) => {
    if (typeof data !== 'string') return;
    sessions.get(sessionId)?.handle.write(data);
  });

  ipcMain.on(IPC.resize, (_e, sessionId: string, cols: number, rows: number) => {
    sessions.get(sessionId)?.handle.resize(Number(cols), Number(rows));
  });

  ipcMain.handle(IPC.closeSession, async (_e, sessionId: string) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    s.emitter.dispose();
    try {
      await s.handle.close();
    } catch (err) {
      console.error('[main] close session failed:', err);
    }
  });

  ipcMain.handle(IPC.remoteCwd, async (_e, sessionId: string) => {
    const s = sessions.get(sessionId);
    if (!s?.handle.remoteCwd) return null;
    try {
      return await s.handle.remoteCwd();
    } catch {
      return null;
    }
  });
}

async function closeAllSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(all.map(async (s) => {
    s.emitter.dispose();
    await s.handle.close();
  }));
}

// ---------- окно ----------

function materialFor(settings: Settings): 'mica' | 'acrylic' | 'none' {
  return isWin ? settings.backgroundMaterial : 'none';
}

function applyMaterial(win: BrowserWindow, settings: Settings): void {
  if (!isWin) return;
  const material = materialFor(settings);
  try {
    win.setBackgroundMaterial(material);
    win.setBackgroundColor(material === 'none' ? '#0A0E14' : '#00000000');
  } catch (err) {
    console.error('[main] background material failed:', err);
  }
}

function sendWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.webContents.send(IPC.windowState, {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    focused: win.isFocused(),
  });
}

function iconPath(): string | undefined {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'icon.png'),
    path.join(__dirname, '..', 'build', 'icon.png'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function createWindow(): BrowserWindow {
  const settings = store.settings();
  const material = materialFor(settings);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Termuxx',
    icon: isWin ? undefined : iconPath(),
    backgroundColor: material === 'none' ? '#0A0E14' : '#00000000',
    ...(isWin
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#00000000', symbolColor: '#E8EDF3', height: 40 },
          backgroundMaterial: material,
        }
      : { frame: false }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: false,
    },
  });

  const indexUrl = `file://${path.join(__dirname, 'renderer', 'index.html').replace(/\\/g, '/')}`;

  win.webContents.on('will-navigate', (e, url) => {
    if (url === indexUrl || url.startsWith(`${indexUrl}#`)) return;
    e.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => {
    if (!SMOKE) win.show();
  });
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const) {
    win.on(ev as 'maximize', () => sendWindowState(win));
  }
  win.webContents.on('did-finish-load', () => sendWindowState(win));

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    void closeAllSessions();
  });

  if (SMOKE) attachSmokeTest(win);

  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

function attachSmokeTest(win: BrowserWindow): void {
  const wc = win.webContents;
  wc.on('console-message', (details) => {
    const d = details as unknown as { level?: string | number; message?: string };
    const level = String(d.level ?? '');
    if (level === 'error' || level === '3') process.stderr.write(`[renderer] ${d.message ?? ''}\n`);
  });
  wc.on('preload-error', (_e, p, err) => smokeFail(`preload error in ${p}: ${err?.stack ?? err}`));
  wc.on('did-fail-load', (_e, code, desc) => smokeFail(`did-fail-load ${code} ${desc}`));
  wc.on('render-process-gone', (_e, details) => smokeFail(`renderer gone: ${details.reason}`));
  wc.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const info = await wc.executeJavaScript(
          `({ api: typeof window.termuxx === 'object', root: (document.getElementById('root')?.childElementCount ?? 0) })`,
        ) as { api: boolean; root: number };
        if (!info.api) return smokeFail('preload API (window.termuxx) is missing');
        if (info.root < 1) return smokeFail('renderer did not render anything into #root');
        const shells = await listShells();
        process.stdout.write(`SMOKE OK (shells: ${shells.map((s) => s.id).join(', ') || 'none'})\n`);
        await store.flush();
        app.exit(0);
      } catch (err) {
        smokeFail(`smoke check failed: ${(err as Error)?.stack ?? err}`);
      }
    }, 2500);
  });
}

// ---------- запуск ----------

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    permission === 'clipboard-read' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen');

  await store.load();
  store.onChange((data) => ctx.broadcast(IPC.dataChanged, data));

  registerCoreIpc(store, {
    appVersion: app.getVersion(),
    onSettingsChanged: (settings) => {
      if (mainWindow) applyMaterial(mainWindow, settings);
    },
  });
  registerSessionIpc();
  registerSshIpc(ctx);

  mainWindow = createWindow();
}).catch((err) => {
  console.error('[main] startup failed:', err);
  smokeFail(`startup failed: ${err?.stack ?? err}`);
  if (!SMOKE) app.exit(1);
});

app.on('window-all-closed', () => {
  app.quit();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  const done = Promise.allSettled([closeAllSessions(), shutdownSsh(), store.flush()]);
  const timeout = new Promise((r) => setTimeout(r, 3000));
  void Promise.race([done, timeout]).finally(() => app.quit());
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) mainWindow = createWindow();
});
