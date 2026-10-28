// Мост между renderer и main: window.termuxx (контракт — src/shared/api.ts).
// Соглашение: методы с Promise → ipcRenderer.invoke (ipcMain.handle), void → ipcRenderer.send (ipcMain.on),
// clipboardRead → sendSync. Аргументы передаются позиционно, в порядке параметров метода.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type TermuxxAPI, type Unsubscribe } from '../shared/api';

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: IpcRendererEvent, payload: T) => {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[termuxx] listener for ${channel} failed`, err);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;
const send = (channel: string, ...args: unknown[]): void => ipcRenderer.send(channel, ...args);

let info: { version: string; platform: string } = { version: '0.0.0', platform: process.platform };
try {
  info = ipcRenderer.sendSync('sys:info') ?? info;
} catch {
  /* главный процесс ещё не готов — оставим значения по умолчанию */
}

const api: TermuxxAPI = {
  platform: (['win32', 'linux', 'darwin'].includes(info.platform) ? info.platform : 'linux') as TermuxxAPI['platform'],
  version: info.version,

  // --- данные ---
  loadData: () => invoke(IPC.loadData),
  saveServer: (server) => invoke(IPC.saveServer, server),
  deleteServer: (id) => invoke(IPC.deleteServer, id),
  saveSnippet: (snippet) => invoke(IPC.saveSnippet, snippet),
  deleteSnippet: (id) => invoke(IPC.deleteSnippet, id),
  saveSettings: (settings) => invoke(IPC.saveSettings, settings),
  forgetHostKey: (hostPort) => invoke(IPC.forgetHostKey, hostPort),
  onDataChanged: (cb) => on(IPC.dataChanged, cb),

  // --- секреты ---
  hasPassword: (serverId) => invoke(IPC.hasPassword, serverId),
  setPassword: (serverId, password) => invoke(IPC.setPassword, serverId, password),
  setProxyPassword: (serverId, password) => invoke(IPC.setProxyPassword, serverId, password),

  // --- ключи ---
  generateKey: (name, passphrase) => invoke(IPC.generateKey, name, passphrase),
  importKey: (name, pem, passphrase) => invoke(IPC.importKey, name, pem, passphrase),
  importKeyFile: () => invoke(IPC.importKeyFile),
  deleteKey: (id) => invoke(IPC.deleteKey, id),
  installKey: (keyId, serverId) => invoke(IPC.installKey, keyId, serverId),

  // --- оболочки и сессии ---
  listShells: () => invoke(IPC.listShells),
  openSession: (req) => invoke(IPC.openSession, req),
  write: (sessionId, data) => send(IPC.write, sessionId, data),
  resize: (sessionId, cols, rows) => send(IPC.resize, sessionId, cols, rows),
  closeSession: (sessionId) => invoke(IPC.closeSession, sessionId),
  remoteCwd: (sessionId) => invoke(IPC.remoteCwd, sessionId),
  onSessionData: (cb) => on(IPC.sessionData, cb),
  onSessionStatus: (cb) => on(IPC.sessionStatus, cb),

  // --- запросы к пользователю ---
  onHostKeyPrompt: (cb) => on(IPC.hostKeyPrompt, cb),
  answerHostKey: (requestId, accept) => send(IPC.hostKeyAnswer, requestId, accept),
  onAuthPrompt: (cb) => on(IPC.authPrompt, cb),
  answerAuth: (requestId, answer) => send(IPC.authAnswer, requestId, answer),

  // --- SFTP ---
  sftpHome: (sessionId) => invoke(IPC.sftpHome, sessionId),
  sftpList: (sessionId, path) => invoke(IPC.sftpList, sessionId, path),
  sftpMkdir: (sessionId, path) => invoke(IPC.sftpMkdir, sessionId, path),
  sftpRename: (sessionId, from, to) => invoke(IPC.sftpRename, sessionId, from, to),
  sftpDelete: (sessionId, paths) => invoke(IPC.sftpDelete, sessionId, paths),
  sftpChmod: (sessionId, path, mode) => invoke(IPC.sftpChmod, sessionId, path, mode),
  sftpReadText: (sessionId, path) => invoke(IPC.sftpReadText, sessionId, path),
  sftpWriteText: (sessionId, path, text) => invoke(IPC.sftpWriteText, sessionId, path, text),
  sftpDownload: (sessionId, remotePaths, localDir) => invoke(IPC.sftpDownload, sessionId, remotePaths, localDir),
  sftpUpload: (sessionId, remoteDir, localPaths) => invoke(IPC.sftpUpload, sessionId, remoteDir, localPaths),
  sftpOpenExternal: (sessionId, remotePath) => invoke(IPC.sftpOpenExternal, sessionId, remotePath),
  cancelTransfer: (transferId) => send(IPC.cancelTransfer, transferId),
  onTransfer: (cb) => on(IPC.transfer, cb),

  // --- мониторинг ---
  monitorStart: (sessionId, intervalMs) => send(IPC.monitorStart, sessionId, intervalMs),
  monitorStop: (sessionId) => send(IPC.monitorStop, sessionId),
  onMonitor: (cb) => on(IPC.monitor, cb),
  listServices: (sessionId) => invoke(IPC.listServices, sessionId),
  listContainers: (sessionId) => invoke(IPC.listContainers, sessionId),
  serviceAction: (sessionId, name, action) => invoke(IPC.serviceAction, sessionId, name, action),
  containerAction: (sessionId, name, action) => invoke(IPC.containerAction, sessionId, name, action),

  // --- туннели ---
  tunnelStart: (sessionId, forward) => invoke(IPC.tunnelStart, sessionId, forward),
  tunnelStop: (forwardId) => invoke(IPC.tunnelStop, forwardId),
  tunnelList: () => invoke(IPC.tunnelList),
  onTunnels: (cb) => on(IPC.tunnels, cb),

  // --- бэкап ---
  backupExport: (includeSecrets, password) => invoke(IPC.backupExport, includeSecrets, password),
  backupInspect: () => invoke(IPC.backupInspect),
  backupImport: (path, password) => invoke(IPC.backupImport, path, password),
  importSshConfig: () => invoke(IPC.importSshConfig),
  importPutty: () => invoke(IPC.importPutty),

  // --- окно и система ---
  openExternal: (url) => send(IPC.openExternal, url),
  showItemInFolder: (path) => send(IPC.showItemInFolder, path),
  clipboardRead: () => {
    try {
      return String(ipcRenderer.sendSync(IPC.clipboardRead) ?? '');
    } catch {
      return '';
    }
  },
  clipboardWrite: (text) => send(IPC.clipboardWrite, text),
  windowControl: (action) => send(IPC.windowControl, action),
  onWindowState: (cb) => on(IPC.windowState, cb),
};

contextBridge.exposeInMainWorld('termuxx', api);
