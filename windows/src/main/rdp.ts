// RDP через встроенный клиент Windows (mstsc.exe).
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MainContext, SessionEmitter, SessionHandle } from './contracts';
import type { UUID } from '../shared/types';

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}

export async function openRdpSession(
  ctx: MainContext,
  req: { kind: 'rdp'; serverId: UUID },
  sessionId: string,
  emit: SessionEmitter,
): Promise<SessionHandle> {
  if (process.platform !== 'win32') {
    throw new Error('RDP-подключения доступны только в Windows (используется «Подключение к удалённому рабочему столу»).');
  }
  const server = ctx.store.server(req.serverId);
  if (!server) throw new Error('Сервер не найден.');

  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const mstsc = path.join(sysRoot, 'System32', 'mstsc.exe');
  if (!fs.existsSync(mstsc)) throw new Error('Не найден mstsc.exe — клиент удалённого рабочего стола недоступен.');

  const port = server.port && server.port !== 22 ? server.port : 3389;
  const target = port === 3389 ? server.hostname : `${server.hostname}:${port}`;

  // Сохранённый пароль передаём через диспетчер учётных данных Windows (как делает сам mstsc).
  const password = ctx.store.password(server.id);
  if (password && server.username) {
    const cmdkey = path.join(sysRoot, 'System32', 'cmdkey.exe');
    if (fs.existsSync(cmdkey)) {
      await run(cmdkey, [`/generic:TERMSRV/${server.hostname}`, `/user:${server.username}`, `/pass:${password}`]);
    }
  }

  const child = spawn(mstsc, [`/v:${target}`], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (err) => emit.status({ status: 'error', message: `Не удалось открыть RDP: ${err.message}` }));
  child.unref();

  ctx.store.markConnected(server.id);
  emit.status({ status: 'connected', message: `Открыто окно удалённого рабочего стола (${target}).` });

  return {
    id: sessionId,
    kind: 'rdp',
    write() { /* RDP не принимает ввод через Termuxx */ },
    resize() { /* нет терминала */ },
    close() { /* окно mstsc живёт отдельно */ },
  };
}
