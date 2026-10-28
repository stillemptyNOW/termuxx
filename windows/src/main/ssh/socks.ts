// Минимальный SOCKS5: клиент (подключение к серверу через прокси) и сервер (динамический проброс -D).
import net from 'node:net';
import { UserFacingError } from './util';

const REPLY_TEXT: Record<number, string> = {
  1: 'общая ошибка прокси',
  2: 'запрещено правилами прокси',
  3: 'сеть недоступна',
  4: 'хост недоступен',
  5: 'соединение отклонено',
  6: 'истёк TTL',
  7: 'команда не поддерживается',
  8: 'тип адреса не поддерживается',
};

export interface Socks5Proxy {
  host: string;
  port: number;
  username?: string;
  password?: string | null;
}

/** Открыть TCP-соединение до targetHost:targetPort через SOCKS5-прокси. */
export function socks5Connect(proxy: Socks5Proxy, targetHost: string, targetPort: number, timeoutMs = 15_000): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port || 1080 });
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'connect' | 'done' = 'greeting';
    let settled = false;
    const useAuth = !!proxy.username;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(new UserFacingError(`SOCKS5-прокси: ${message}`));
    };
    const timer = setTimeout(() => fail('нет ответа (таймаут)'), timeoutMs);

    sock.once('connect', () => {
      sock.setNoDelay(true);
      sock.write(useAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    });
    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') fail(`соединение отклонено (${proxy.host}:${proxy.port})`);
      else if (err.code === 'ENOTFOUND') fail(`не найден адрес ${proxy.host}`);
      else fail(err.message);
    });
    sock.on('close', () => fail('закрыл соединение'));

    const sendConnect = () => {
      stage = 'connect';
      const parts: Buffer[] = [Buffer.from([0x05, 0x01, 0x00])];
      if (net.isIPv4(targetHost)) {
        parts.push(Buffer.from([0x01]), Buffer.from(targetHost.split('.').map((x) => Number(x))));
      } else if (net.isIPv6(targetHost)) {
        parts.push(Buffer.from([0x04]), ipv6ToBuffer(targetHost));
      } else {
        const host = Buffer.from(targetHost, 'utf8').subarray(0, 255);
        parts.push(Buffer.from([0x03, host.length]), host);
      }
      const port = Buffer.alloc(2);
      port.writeUInt16BE(targetPort);
      parts.push(port);
      sock.write(Buffer.concat(parts));
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const method = buf[1];
          buf = buf.subarray(2);
          if (method === 0x00) {
            sendConnect();
          } else if (method === 0x02 && useAuth) {
            stage = 'auth';
            const u = Buffer.from(proxy.username ?? '', 'utf8').subarray(0, 255);
            const p = Buffer.from(proxy.password ?? '', 'utf8').subarray(0, 255);
            sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          } else {
            fail('не принял способ входа');
            return;
          }
        } else if (stage === 'auth') {
          if (buf.length < 2) return;
          const status = buf[1];
          buf = buf.subarray(2);
          if (status !== 0x00) { fail('неверный логин или пароль'); return; }
          sendConnect();
        } else if (stage === 'connect') {
          if (buf.length < 5) return;
          const rep = buf[1];
          const atyp = buf[3];
          const total = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 7 + buf[4] : -1;
          if (total < 0) { fail('непонятный ответ'); return; }
          if (buf.length < total) return;
          if (rep !== 0x00) { fail(REPLY_TEXT[rep] ?? `код ${rep}`); return; }
          const rest = buf.subarray(total);
          stage = 'done';
          settled = true;
          clearTimeout(timer);
          sock.removeListener('data', onData);
          sock.removeAllListeners('close');
          sock.removeAllListeners('error');
          // ssh2 подписывается на 'data' асинхронно — держим поток на паузе, чтобы не потерять
          // баннер сервера, и возобновляем, как только появится слушатель.
          sock.pause();
          if (rest.length) sock.unshift(rest);
          const onNewListener = (event: string | symbol) => {
            if (event !== 'data') return;
            sock.removeListener('newListener', onNewListener);
            process.nextTick(() => sock.resume());
          };
          sock.on('newListener', onNewListener);
          resolve(sock);
          return;
        } else {
          return;
        }
      }
    };
    sock.on('data', onData);
  });
}

function ipv6ToBuffer(addr: string): Buffer {
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : [];
  const groups = [...h, ...fill, ...t].slice(0, 8);
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16) & 0xffff, i * 2));
  return out;
}

function bufferToIpv6(b: Buffer): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
  return parts.join(':');
}

/**
 * Принимает SOCKS5-рукопожатие от локального клиента (браузера и т.п.) и вызывает
 * onConnect(host, port) — тот должен вернуть поток к цели (через SSH). Без авторизации, только CONNECT.
 */
export function handleSocks5Client(
  client: net.Socket,
  onConnect: (host: string, port: number) => Promise<NodeJS.ReadWriteStream & { destroy?: () => void }>,
): Promise<{ host: string; port: number; remote: NodeJS.ReadWriteStream & { destroy?: () => void } } | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'request' | 'done' = 'greeting';
    const finish = (value: { host: string; port: number; remote: NodeJS.ReadWriteStream & { destroy?: () => void } } | null) => {
      client.removeListener('data', onData);
      resolve(value);
    };
    const reply = (rep: number) => {
      client.write(Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf[0] !== 0x05) { client.destroy(); finish(null); return; }
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0x00)) {
          client.end(Buffer.from([0x05, 0xff]));
          finish(null);
          return;
        }
        client.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        const cmd = buf[1];
        const atyp = buf[3];
        let host = '';
        let offset = 4;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          host = Array.from(buf.subarray(4, 8)).join('.');
          offset = 8;
        } else if (atyp === 0x03) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString('utf8');
          offset = 5 + len;
        } else if (atyp === 0x04) {
          if (buf.length < 22) return;
          host = bufferToIpv6(buf.subarray(4, 20));
          offset = 20;
        } else {
          reply(0x08);
          client.end();
          finish(null);
          return;
        }
        const port = buf.readUInt16BE(offset);
        const rest = buf.subarray(offset + 2);
        stage = 'done';
        client.removeListener('data', onData);
        if (cmd !== 0x01) {
          reply(0x07);
          client.end();
          resolve(null);
          return;
        }
        client.pause();
        onConnect(host, port).then((remote) => {
          reply(0x00);
          if (rest.length) remote.write(rest);
          // Не возобновляем поток здесь: pipe() в relay сделает это сам, без потери данных.
          resolve({ host, port, remote });
        }).catch(() => {
          reply(0x05);
          client.end();
          resolve(null);
        });
      }
    };
    client.on('data', onData);
    client.on('error', () => finish(null));
  });
}
