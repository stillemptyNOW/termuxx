// SSH-слой Termuxx для Windows: сессии, SFTP, мониторинг, туннели, установка ключей.
// Экспорты зафиксированы контрактом (src/main/contracts.ts).
import { ipcMain } from 'electron';
import { utils } from 'ssh2';
import type { ParsedKey } from 'ssh2';
import { IPC } from '../../shared/api';
import type { PortForward } from '../../shared/types';
import type { MainContext, SessionEmitter, SessionHandle, SshSessionRequest } from '../contracts';
import { PromptBroker } from '../prompts';
import { SshConnection, connectServer } from './connect';
import {
  containerAction, listContainers, listServices, monitorStart, monitorStop, serviceAction, stopAllMonitors,
} from './monitor';
import { SessionHooks, SshSession, closeAllSessions, createSession, findConnectedSession } from './session';
import {
  cancelSessionTransfers, cancelTransfer, sftpChmod, sftpDelete, sftpDownload, sftpHome, sftpList, sftpMkdir,
  sftpOpenExternal, sftpReadText, sftpRename, sftpUpload, sftpWriteText,
} from './sftp';
import { startAutoTunnels, stopAllTunnels, stopSessionTunnels, tunnelList, tunnelStart, tunnelStop } from './tunnels';
import { UserFacingError, execCommand, friendlyMessage, sh } from './util';

let broker: PromptBroker | null = null;
let context: MainContext | null = null;

function getBroker(ctx: MainContext): PromptBroker {
  if (!broker) {
    broker = new PromptBroker(ctx);
    broker.register();
  }
  context = ctx;
  return broker;
}

function hooksFor(ctx: MainContext): SessionHooks {
  return {
    onConnected(session: SshSession) {
      void startAutoTunnels(ctx, session).then((errors) => {
        // Покажем прямо в терминале, как это делает ssh -L.
        for (const e of errors) session.notice(`\x1b[33m⚠ ${e}\x1b[0m`);
      });
    },
    onClosed(session: SshSession) {
      monitorStop(session.id);
      cancelSessionTransfers(session.id);
      stopSessionTunnels(ctx, session.id);
    },
  };
}

/** Открыть SSH-сессию терминала. Возвращается сразу; подключение и вопросы пользователю идут в фоне. */
export async function createSshSession(
  ctx: MainContext,
  req: SshSessionRequest,
  sessionId: string,
  emit: SessionEmitter,
): Promise<SessionHandle> {
  const b = getBroker(ctx);
  return createSession(ctx, b, hooksFor(ctx), req, sessionId, emit);
}

/** Закрыть все SSH-сессии, туннели и опросы (при выходе из приложения). */
export async function shutdownSsh(): Promise<void> {
  stopAllMonitors();
  if (context) stopAllTunnels(context);
  broker?.cancelAll();
  await closeAllSessions();
}

// ---------------------------------------------------------------------------
// Установка публичного ключа на сервер

function installCommand(publicKey: string): string {
  const escaped = publicKey.replace(/'/g, '').replace(/[\r\n]+/g, ' ').trim();
  return sh(
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && ` +
    `(grep -qxF '${escaped}' ~/.ssh/authorized_keys || echo '${escaped}' >> ~/.ssh/authorized_keys) && ` +
    `chmod 600 ~/.ssh/authorized_keys && echo OK`,
  );
}

function publicKeyLine(ctx: MainContext, keyId: string): string {
  const item = ctx.store.data().keys.find((k) => k.id.toUpperCase() === keyId.toUpperCase());
  if (!item) throw new UserFacingError('Ключ не найден.');
  if (item.publicKey?.trim()) return item.publicKey.trim();
  // Публичной части нет (например, импортировали только приватный ключ) — достаём из приватного.
  const pem = ctx.store.privateKey(item.id);
  if (!pem) throw new UserFacingError('Приватный ключ не найден.');
  const parsed = utils.parseKey(pem.trim(), ctx.store.passphrase(item.id) ?? undefined) as ParsedKey | ParsedKey[] | Error;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new UserFacingError('Не удалось получить публичную часть ключа (ключ защищён паролем?).');
  const comment = item.name?.trim() ? ` ${item.name.trim().replace(/\s+/g, '-')}` : '';
  return `${key.type} ${key.getPublicSSH().toString('base64')}${comment}`;
}

export async function installKey(ctx: MainContext, keyId: string, serverId: string): Promise<string> {
  const server = ctx.store.server(serverId);
  if (!server) throw new UserFacingError('Сервер не найден.');
  const line = publicKeyLine(ctx, keyId);
  const open = findConnectedSession(serverId);
  let temp: SshConnection | null = null;
  try {
    const client = open?.connection?.client ?? (temp = await connectServer(ctx, getBroker(ctx), server)).client;
    const { output, code } = await execCommand(client, installCommand(line), { timeoutMs: 30_000 });
    const text = output.trim();
    if (code === 0 && /(^|\n)OK$/.test(text)) return `Ключ установлен на ${server.name || server.hostname}.`;
    throw new UserFacingError(text ? `Сервер ответил: ${text}` : `Не удалось установить ключ (код ${code ?? '?'}).`);
  } finally {
    temp?.close();
  }
}

// ---------------------------------------------------------------------------
// IPC

/** ipcMain.handle с переводом ошибок в понятный текст (renderer показывает err.message). */
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw new Error(friendlyMessage(err));
    }
  });
}

/** Для «void»-методов API: preload шлёт send(); на всякий случай принимаем и invoke(). */
function onAndHandle(channel: string, fn: (...args: any[]) => void): void {
  ipcMain.on(channel, (_event, ...args: unknown[]) => {
    try { fn(...args); } catch (err) { console.error(`[ssh] ${channel}:`, err); }
  });
  try {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => { fn(...args); });
  } catch {
    // уже зарегистрирован
  }
}

export function registerSshIpc(ctx: MainContext): void {
  getBroker(ctx);

  handle(IPC.sftpHome, (sessionId: string) => sftpHome(sessionId));
  handle(IPC.sftpList, (sessionId: string, path: string) => sftpList(sessionId, path));
  handle(IPC.sftpMkdir, (sessionId: string, path: string) => sftpMkdir(sessionId, path));
  handle(IPC.sftpRename, (sessionId: string, from: string, to: string) => sftpRename(sessionId, from, to));
  handle(IPC.sftpDelete, (sessionId: string, paths: string[]) => sftpDelete(sessionId, Array.isArray(paths) ? paths : [paths]));
  handle(IPC.sftpChmod, (sessionId: string, path: string, mode: number) => sftpChmod(sessionId, path, Number(mode)));
  handle(IPC.sftpReadText, (sessionId: string, path: string) => sftpReadText(sessionId, path));
  handle(IPC.sftpWriteText, (sessionId: string, path: string, text: string) => sftpWriteText(sessionId, path, String(text ?? '')));
  handle(IPC.sftpDownload, (sessionId: string, remotePaths: string[], localDir?: string) =>
    sftpDownload(ctx, sessionId, Array.isArray(remotePaths) ? remotePaths : [remotePaths], localDir || undefined));
  handle(IPC.sftpUpload, (sessionId: string, remoteDir: string, localPaths?: string[]) =>
    sftpUpload(ctx, sessionId, remoteDir, Array.isArray(localPaths) ? localPaths : undefined));
  handle(IPC.sftpOpenExternal, (sessionId: string, remotePath: string) => sftpOpenExternal(ctx, sessionId, remotePath));
  onAndHandle(IPC.cancelTransfer, (transferId: string) => cancelTransfer(String(transferId)));

  onAndHandle(IPC.monitorStart, (sessionId: string, intervalMs?: number) => monitorStart(ctx, String(sessionId), intervalMs));
  onAndHandle(IPC.monitorStop, (sessionId: string) => monitorStop(String(sessionId)));
  handle(IPC.listServices, (sessionId: string) => listServices(sessionId));
  handle(IPC.listContainers, (sessionId: string) => listContainers(sessionId));
  handle(IPC.serviceAction, (sessionId: string, name: string, action: 'restart' | 'start' | 'stop' | 'logs') =>
    serviceAction(sessionId, String(name), action));
  handle(IPC.containerAction, (sessionId: string, name: string, action: 'restart' | 'start' | 'stop' | 'logs') =>
    containerAction(sessionId, String(name), action));

  handle(IPC.tunnelStart, (sessionId: string, forward: PortForward) => tunnelStart(ctx, sessionId, forward));
  handle(IPC.tunnelStop, (forwardId: string) => tunnelStop(ctx, String(forwardId)));
  handle(IPC.tunnelList, () => tunnelList());

  handle(IPC.installKey, (keyId: string, serverId: string) => installKey(ctx, String(keyId), String(serverId)));
}
