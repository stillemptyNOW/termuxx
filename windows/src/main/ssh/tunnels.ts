// Туннели поверх SSH-сессии: локальный (-L), удалённый (-R) и динамический SOCKS5 (-D) проброс портов.
//
// Поля PortForward по типам:
//   local   (-L): слушаем 127.0.0.1:localPort на этом ПК → сервер подключается к remoteHost:remotePort.
//   remote  (-R): сервер слушает 127.0.0.1:remotePort у себя → соединения идут на remoteHost:localPort, если смотреть с этого ПК
//                 (remoteHost обычно 127.0.0.1 или адрес в локальной сети ПК).
//   dynamic (-D): SOCKS5-прокси на 127.0.0.1:localPort → любые адреса через сервер (remoteHost/remotePort не используются).
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { IPC } from '../../shared/api';
import type { PortForward, TunnelState } from '../../shared/types';
import type { MainContext } from '../contracts';
import { handleSocks5Client } from './socks';
import { SshSession, requireSession } from './session';
import { UserFacingError, friendlyMessage } from './util';

interface Runtime {
  state: TunnelState;
  sockets: Set<net.Socket | Duplex>;
  server?: net.Server;
  /** Для -R: снять обработчик и отменить forwardIn. */
  disposeRemote?: () => void;
}

const tunnels = new Map<string, Runtime>();
let broadcastTimer: NodeJS.Timeout | null = null;

export function tunnelList(): TunnelState[] {
  return [...tunnels.values()].map((r) => ({ ...r.state, forward: { ...r.state.forward } }));
}

function emitTunnels(ctx: MainContext, immediate = false): void {
  if (immediate) {
    if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
    ctx.broadcast(IPC.tunnels, tunnelList());
    return;
  }
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    ctx.broadcast(IPC.tunnels, tunnelList());
  }, 1000);
}

function forwardType(forward: PortForward): 'local' | 'remote' | 'dynamic' {
  return forward.type ?? 'local';
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

/** Склеить локальный сокет с SSH-потоком и считать трафик. */
function relay(ctx: MainContext, rt: Runtime, local: net.Socket, remote: Duplex): void {
  rt.sockets.add(local);
  rt.sockets.add(remote);
  rt.state.connections++;
  emitTunnels(ctx);
  local.on('data', (d: Buffer) => { rt.state.bytesOut += d.length; emitTunnels(ctx); });
  remote.on('data', (d: Buffer) => { rt.state.bytesIn += d.length; emitTunnels(ctx); });
  local.pipe(remote).pipe(local);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    rt.sockets.delete(local);
    rt.sockets.delete(remote);
    rt.state.connections = Math.max(0, rt.state.connections - 1);
    try { local.destroy(); } catch { /* ignore */ }
    try { remote.destroy(); } catch { /* ignore */ }
    emitTunnels(ctx);
  };
  local.on('close', close);
  local.on('error', close);
  remote.on('close', close);
  remote.on('error', close);
}

function forwardOut(session: SshSession, srcPort: number, host: string, port: number): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const client = session.connection?.client;
    if (!client || !session.connected) {
      reject(new UserFacingError('Сессия не подключена.'));
      return;
    }
    try {
      client.forwardOut('127.0.0.1', srcPort || 0, host, port, (err, stream) => {
        if (err) reject(err);
        else resolve(stream as unknown as Duplex);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') reject(new UserFacingError(`Порт ${port} уже занят другой программой.`));
      else if (err.code === 'EACCES') reject(new UserFacingError(`Нет прав открыть порт ${port}.`));
      else reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function tunnelStart(ctx: MainContext, sessionId: string, forward: PortForward): Promise<void> {
  const session = requireSession(sessionId);
  const type = forwardType(forward);
  if (!validPort(forward.localPort) && type !== 'remote') throw new UserFacingError('Неверный локальный порт (1–65535).');
  if (type === 'local' && (!validPort(forward.remotePort) || !forward.remoteHost?.trim())) {
    throw new UserFacingError('Укажите адрес и порт назначения.');
  }
  if (type === 'remote' && (!validPort(forward.remotePort) || !validPort(forward.localPort))) {
    throw new UserFacingError('Неверный порт (1–65535).');
  }

  const existing = tunnels.get(forward.id);
  if (existing) {
    if (existing.state.status === 'active' || existing.state.status === 'starting') {
      if (existing.state.sessionId === sessionId) return;
      throw new UserFacingError('Этот туннель уже запущен в другой сессии.');
    }
    stopRuntime(existing);
    tunnels.delete(forward.id);
  }

  const rt: Runtime = {
    state: {
      id: forward.id,
      serverId: session.server.id,
      sessionId,
      forward: { ...forward },
      status: 'starting',
      connections: 0,
      bytesIn: 0,
      bytesOut: 0,
    },
    sockets: new Set(),
  };
  tunnels.set(forward.id, rt);
  emitTunnels(ctx, true);

  try {
    if (type === 'local' || type === 'dynamic') {
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        if (type === 'local') {
          socket.pause();
          forwardOut(session, socket.remotePort ?? 0, forward.remoteHost.trim(), forward.remotePort)
            .then((stream) => relay(ctx, rt, socket, stream)) // pipe() сам возобновит поток
            .catch((err) => {
              rt.state.error = friendlyMessage(err);
              emitTunnels(ctx);
              socket.destroy();
            });
        } else {
          handleSocks5Client(socket, (host, port) => forwardOut(session, socket.remotePort ?? 0, host, port))
            .then((result) => {
              if (!result) { socket.destroy(); return; }
              relay(ctx, rt, socket, result.remote as unknown as Duplex);
            })
            .catch(() => socket.destroy());
        }
      });
      rt.server = server;
      server.on('error', (err) => {
        rt.state.status = 'error';
        rt.state.error = friendlyMessage(err);
        emitTunnels(ctx, true);
      });
      await listen(server, forward.localPort);
    } else {
      await startRemote(ctx, session, rt, forward);
    }
    rt.state.status = 'active';
    rt.state.error = undefined;
    session.disposers.add(() => tunnelStopById(ctx, forward.id));
    emitTunnels(ctx, true);
  } catch (err) {
    stopRuntime(rt);
    if (tunnels.get(forward.id) === rt) tunnels.delete(forward.id);
    emitTunnels(ctx, true);
    throw new UserFacingError(friendlyMessage(err));
  }
}

function startRemote(ctx: MainContext, session: SshSession, rt: Runtime, forward: PortForward): Promise<void> {
  const client = session.connection!.client;
  const bindAddr = '127.0.0.1';
  const targetHost = (forward.remoteHost || '127.0.0.1').trim();
  const onConnection = (
    details: { destIP: string; destPort: number },
    accept: () => Duplex,
    reject: () => void,
  ) => {
    if (details.destPort !== forward.remotePort) return; // это не наш туннель
    const local = net.connect(forward.localPort, targetHost);
    local.once('connect', () => {
      local.setNoDelay(true);
      const stream = accept();
      relay(ctx, rt, local, stream);
    });
    local.once('error', (err) => {
      try { reject(); } catch { /* ignore */ }
      rt.state.error = `Не удалось подключиться к ${targetHost}:${forward.localPort} на этом ПК: ${friendlyMessage(err)}`;
      emitTunnels(ctx);
    });
  };
  client.on('tcp connection', onConnection as never);
  rt.disposeRemote = () => {
    client.removeListener('tcp connection', onConnection as never);
    try { client.unforwardIn(bindAddr, forward.remotePort); } catch { /* соединение уже закрыто */ }
  };
  return new Promise<void>((resolve, reject) => {
    try {
      client.forwardIn(bindAddr, forward.remotePort, (err) => {
        if (err) reject(new UserFacingError(`Сервер не разрешил слушать порт ${forward.remotePort} (занят или запрещён AllowTcpForwarding).`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

function stopRuntime(rt: Runtime): void {
  try { rt.server?.close(); } catch { /* ignore */ }
  rt.server = undefined;
  try { rt.disposeRemote?.(); } catch { /* ignore */ }
  rt.disposeRemote = undefined;
  for (const s of rt.sockets) {
    try { s.destroy(); } catch { /* ignore */ }
  }
  rt.sockets.clear();
  rt.state.connections = 0;
}

function tunnelStopById(ctx: MainContext, forwardId: string): void {
  const rt = tunnels.get(forwardId);
  if (!rt) return;
  stopRuntime(rt);
  tunnels.delete(forwardId);
  emitTunnels(ctx, true);
}

export async function tunnelStop(ctx: MainContext, forwardId: string): Promise<void> {
  tunnelStopById(ctx, forwardId);
}

export function stopSessionTunnels(ctx: MainContext, sessionId: string): void {
  let changed = false;
  for (const [id, rt] of tunnels) {
    if (rt.state.sessionId !== sessionId) continue;
    stopRuntime(rt);
    tunnels.delete(id);
    changed = true;
  }
  if (changed) emitTunnels(ctx, true);
}

export function stopAllTunnels(ctx: MainContext): void {
  for (const rt of tunnels.values()) stopRuntime(rt);
  tunnels.clear();
  emitTunnels(ctx, true);
}

/** Автозапуск пробросов сервера при подключении. Возвращает тексты ошибок для вывода в терминал. */
export async function startAutoTunnels(ctx: MainContext, session: SshSession): Promise<string[]> {
  const errors: string[] = [];
  // Берём свежую версию сервера из хранилища (могли поменять после открытия вкладки).
  const server = ctx.store.server(session.server.id) ?? session.server;
  for (const forward of server.forwards ?? []) {
    if (!forward.autoStart) continue;
    try {
      await tunnelStart(ctx, session.id, forward);
    } catch (err) {
      const port = forwardType(forward) === 'remote' ? forward.remotePort : forward.localPort;
      errors.push(`Туннель ${forward.name || port}: ${friendlyMessage(err)}`);
    }
  }
  return errors;
}
