// IPC ядра: данные, секреты, ключи, бэкап, импорт, система и окно.
// SSH-часть (sftp/monitor/tunnel/key:install/prompt-ответы) регистрирует src/main/ssh.
import { BrowserWindow, clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/api';
import type { Server, Settings, Snippet } from '../shared/types';
import { exportBackup, importBackup, inspectBackup } from './backup';
import { importPutty, importSshConfig } from './importers';
import { generateKey, importKey, importKeyFile } from './keys';
import type { Store } from './store';

function winOf(e: IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}

/** Разрешаем открывать наружу только безопасные схемы. */
export function isSafeExternal(url: string): boolean {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol);
  } catch {
    return false;
  }
}

export function registerCoreIpc(store: Store, opts: {
  onSettingsChanged: (settings: Settings) => void;
  appVersion: string;
}): void {
  // --- данные ---
  ipcMain.handle(IPC.loadData, () => store.data());
  ipcMain.handle(IPC.saveServer, (_e, server: Server) => store.saveServer(server));
  ipcMain.handle(IPC.deleteServer, (_e, id: string) => store.deleteServer(id));
  ipcMain.handle(IPC.saveSnippet, (_e, snippet: Snippet) => store.saveSnippet(snippet));
  ipcMain.handle(IPC.deleteSnippet, (_e, id: string) => store.deleteSnippet(id));
  ipcMain.handle(IPC.saveSettings, (_e, settings: Settings) => {
    store.saveSettings(settings);
    opts.onSettingsChanged(store.settings());
  });
  ipcMain.handle(IPC.forgetHostKey, (_e, hostPort: string) => store.forgetHostKey(hostPort));

  // --- секреты ---
  ipcMain.handle(IPC.hasPassword, (_e, serverId: string) => store.hasPassword(serverId));
  ipcMain.handle(IPC.setPassword, (_e, serverId: string, password: string | null) => store.setPassword(serverId, password || null));
  ipcMain.handle(IPC.setProxyPassword, (_e, serverId: string, password: string | null) => store.setProxyPassword(serverId, password || null));

  // --- ключи (установка ключа на сервер — в SSH-модуле) ---
  ipcMain.handle(IPC.generateKey, (_e, name: string, passphrase?: string) => generateKey(store, String(name ?? ''), passphrase || undefined));
  ipcMain.handle(IPC.importKey, (_e, name: string, pem: string, passphrase?: string) =>
    importKey(store, String(name ?? ''), String(pem ?? ''), passphrase || undefined));
  ipcMain.handle(IPC.importKeyFile, (e) => importKeyFile(store, winOf(e)));
  ipcMain.handle(IPC.deleteKey, (_e, id: string) => store.deleteKey(id));

  // --- бэкап и импорт ---
  ipcMain.handle(IPC.backupExport, (e, includeSecrets: boolean, password?: string) =>
    exportBackup(store, winOf(e), !!includeSecrets, password || undefined));
  ipcMain.handle(IPC.backupInspect, (e) => inspectBackup(winOf(e)));
  ipcMain.handle(IPC.backupImport, (_e, path: string, password?: string) => importBackup(store, String(path), password || undefined));
  ipcMain.handle(IPC.importSshConfig, () => importSshConfig(store));
  ipcMain.handle(IPC.importPutty, () => importPutty(store));

  // --- система ---
  ipcMain.on(IPC.openExternal, (_e, url: string) => {
    if (typeof url === 'string' && isSafeExternal(url)) void shell.openExternal(url);
  });
  ipcMain.on(IPC.showItemInFolder, (_e, p: string) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p);
  });
  ipcMain.on(IPC.clipboardRead, (e) => {
    e.returnValue = clipboard.readText();
  });
  ipcMain.on(IPC.clipboardWrite, (_e, text: string) => {
    clipboard.writeText(String(text ?? ''));
  });
  ipcMain.on('sys:info', (e) => {
    e.returnValue = { version: opts.appVersion, platform: process.platform };
  });

  // --- окно ---
  ipcMain.on(IPC.windowControl, (e, action: 'minimize' | 'maximize' | 'close' | 'fullscreen') => {
    const win = winOf(e);
    if (!win) return;
    switch (action) {
      case 'minimize': win.minimize(); break;
      case 'maximize': if (win.isMaximized()) win.unmaximize(); else win.maximize(); break;
      case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
      case 'close': win.close(); break;
    }
  });
}
