// Установка SSH-соединения: прокси/промежуточный сервер, проверка ключа сервера, авторизация.
import { Client, utils } from 'ssh2';
import type { AnyAuthMethod, AuthenticationType, NextAuthHandler, ParsedKey, Prompt } from 'ssh2';
import type { Duplex } from 'node:stream';
import type { Server } from '../../shared/types';
import type { MainContext } from '../contracts';
import type { PromptBroker } from '../prompts';
import { socks5Connect } from './socks';
import { Deadline, UserFacingError, friendlyError, friendlyMessage, hostKeyFingerprint, hostPortKey, serverLabel } from './util';

const HANDSHAKE_TIMEOUT_MS = 20_000;
const MAX_JUMP_DEPTH = 3;

/** Живое SSH-подключение (и, если был, промежуточный сервер). */
export class SshConnection {
  closed = false;
  private closeListeners: ((reason: string | null) => void)[] = [];
  private closeReason: string | null = null;

  constructor(readonly client: Client, readonly server: Server, readonly jump: SshConnection | null) {
    client.on('close', () => this.markClosed(null));
    client.on('end', () => this.markClosed(null));
    client.on('error', (err: Error & { level?: string }) => {
      if (err.level === 'agent') return;
      this.closeReason = friendlyMessage(err, server);
    });
    jump?.onClose(() => {
      // Без промежуточного сервера дальше не уедем.
      try { client.end(); } catch { /* уже закрыт */ }
    });
  }

  get isConnected(): boolean {
    return !this.closed;
  }

  onClose(cb: (reason: string | null) => void): void {
    if (this.closed) {
      cb(this.closeReason);
      return;
    }
    this.closeListeners.push(cb);
  }

  private markClosed(reason: string | null): void {
    if (this.closed) return;
    this.closed = true;
    const why = reason ?? this.closeReason;
    const listeners = this.closeListeners;
    this.closeListeners = [];
    for (const cb of listeners) {
      try { cb(why); } catch { /* слушатель не должен ронять закрытие */ }
    }
    this.jump?.close();
  }

  close(): void {
    try { this.client.end(); } catch { /* ignore */ }
    // Если сервер не ответил на закрытие — через секунду рвём сокет.
    setTimeout(() => {
      if (!this.closed) {
        try { this.client.destroy(); } catch { /* ignore */ }
        this.markClosed(null);
      }
    }, 1500).unref?.();
    this.jump?.close();
  }
}

export interface ConnectOptions {
  /** Пароль, введённый в UI заранее (имеет приоритет над сохранённым). */
  password?: string;
  depth?: number;
}

/** Подключиться к серверу со всей логикой Termuxx. Бросает UserFacingError с понятным текстом. */
export async function connectServer(
  ctx: MainContext,
  broker: PromptBroker,
  server: Server,
  opts: ConnectOptions = {},
): Promise<SshConnection> {
  const depth = opts.depth ?? 0;
  if (!server.hostname?.trim()) throw new UserFacingError('Не указан адрес сервера.');

  let jump: SshConnection | null = null;
  let sock: Duplex | undefined;

  // 1. Промежуточный сервер (jump host).
  if (server.jumpHostID) {
    const jumpServer = ctx.store.server(server.jumpHostID);
    if (!jumpServer || jumpServer.id === server.id) {
      throw new UserFacingError('Промежуточный сервер не найден. Выберите его заново в настройках сервера.');
    }
    if (depth >= MAX_JUMP_DEPTH) throw new UserFacingError('Слишком длинная цепочка промежуточных серверов.');
    try {
      jump = await connectServer(ctx, broker, jumpServer, { depth: depth + 1 });
    } catch (err) {
      throw new UserFacingError(`Промежуточный сервер ${jumpServer.name || jumpServer.hostname}: ${friendlyMessage(err, jumpServer)}`);
    }
    try {
      sock = await new Promise<Duplex>((resolve, reject) => {
        jump!.client.forwardOut('127.0.0.1', 0, server.hostname.trim(), server.port || 22, (err, stream) => {
          if (err) reject(err);
          else resolve(stream as unknown as Duplex);
        });
      });
    } catch (err) {
      jump.close();
      throw new UserFacingError(`Промежуточный сервер не смог подключиться к ${server.hostname}:${server.port || 22}: ${friendlyMessage(err)}`);
    }
  } else if (server.proxy?.host?.trim()) {
    // 2. SOCKS5-прокси.
    sock = await socks5Connect(
      {
        host: server.proxy.host.trim(),
        port: server.proxy.port || 1080,
        username: server.proxy.username || undefined,
        password: ctx.store.proxyPassword(server.id),
      },
      server.hostname.trim(),
      server.port || 22,
    );
  }

  const client = new Client();
  const connection = new SshConnection(client, server, jump);
  const label = serverLabel(server);
  const knownKey = hostPortKey(server);

  return new Promise<SshConnection>((resolve, reject) => {
    let settled = false;
    let hostKeyRejected = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      deadline.clear();
      try { client.end(); } catch { /* ignore */ }
      try { client.destroy(); } catch { /* ignore */ }
      try { sock?.destroy(); } catch { /* ignore */ }
      jump?.close();
      reject(friendlyError(err, server));
    };

    const deadline = new Deadline(HANDSHAKE_TIMEOUT_MS, () => fail(new UserFacingError('Сервер не отвечает (таймаут).')));
    const auth = new AuthFlow(ctx, broker, server, deadline, opts.password);

    client.on('ready', () => {
      if (settled) return;
      settled = true;
      deadline.clear();
      auth.commit();
      try { ctx.store.markConnected(server.id); } catch { /* сервер мог быть не сохранён */ }
      resolve(connection);
    });

    client.on('error', (err: Error & { level?: string }) => {
      if (settled) return;
      if (err.level === 'agent') return; // агент недоступен — ssh2 сам пробует следующий способ
      if (hostKeyRejected) {
        fail(new UserFacingError('Ключ сервера не принят — подключение отменено.'));
        return;
      }
      if (err.level === 'client-authentication') {
        fail(auth.failureError());
        return;
      }
      fail(err);
    });

    client.on('close', () => {
      if (settled) return;
      if (hostKeyRejected) fail(new UserFacingError('Ключ сервера не принят — подключение отменено.'));
      else if (auth.cancelled) fail(new UserFacingError('Подключение отменено.'));
      else fail(new UserFacingError('Соединение закрыто сервером.'));
    });

    try {
      client.connect({
        host: server.hostname.trim(),
        port: server.port || 22,
        username: server.username || 'root',
        sock: sock as never,
        readyTimeout: 0, // своя «пауза на время вопросов» в Deadline
        keepaliveInterval: server.keepAlive === false ? 0 : 30_000,
        keepaliveCountMax: 4,
        tryKeyboard: true,
        hostVerifier: ((key: Buffer, verify: (valid: boolean) => void) => {
          const { keyType, fingerprint } = hostKeyFingerprint(key);
          const value = `${keyType} ${fingerprint}`;
          const known = ctx.store.knownHost(knownKey);
          if (known && known.trim() === value) {
            verify(true);
            return;
          }
          deadline.pause();
          broker.askHostKey({
            serverId: server.id,
            host: server.hostname.trim(),
            port: server.port || 22,
            keyType,
            fingerprint,
            changed: !!known,
            previous: known ?? null,
          }).then((accept) => {
            deadline.resume();
            if (accept) {
              ctx.store.setKnownHost(knownKey, value);
              verify(true);
            } else {
              hostKeyRejected = true;
              verify(false);
            }
          }).catch(() => {
            deadline.resume();
            hostKeyRejected = true;
            verify(false);
          });
        }) as never,
        authHandler: auth.handler as never,
      });
    } catch (err) {
      fail(err);
      return;
    }
    deadline.start();
    void label;
  });
}

// ---------------------------------------------------------------------------
// Авторизация

type Step =
  | { kind: 'key' }
  | { kind: 'agent'; path: string }
  | { kind: 'password'; known: string | null; reason: 'first' | 'retry' | 'fallback' }
  | { kind: 'kbd' };

/** Пошаговая авторизация: ключ / агент / пароль (с повтором) / keyboard-interactive (2FA). */
class AuthFlow {
  cancelled = false;
  private steps: Step[] = [];
  private passwordAttempts = 0;
  private currentPassword: string | null = null;
  private rememberPassword: string | null = null;
  private rememberPassphrase: string | null = null;
  private parsedKey: ParsedKey | null = null;
  private keyError: string | null = null;
  private serverForbidsPassword = false;
  private triedKey = false;
  private lastError: string | null = null;
  private kbdAutoUsed = false;
  /** Последняя попытка была паролем, который сервер даже не проверял (способ не разрешён). */
  private lastWasPassword = false;
  private readonly username: string;
  private readonly label: string;

  constructor(
    private readonly ctx: MainContext,
    private readonly broker: PromptBroker,
    private readonly server: Server,
    private readonly deadline: Deadline,
    presetPassword?: string,
  ) {
    this.username = server.username || 'root';
    this.label = serverLabel(server);
    const known = presetPassword ?? ctx.store.password(server.id);
    switch (server.auth) {
      case 'key':
        this.steps.push({ kind: 'key' });
        this.steps.push({ kind: 'password', known: presetPassword ?? null, reason: 'fallback' });
        break;
      case 'agent':
        for (const path of agentPaths()) this.steps.push({ kind: 'agent', path });
        this.steps.push({ kind: 'password', known: presetPassword ?? null, reason: 'fallback' });
        break;
      default:
        this.steps.push({ kind: 'password', known: known ?? null, reason: 'first' });
        break;
    }
    // 2FA (пароль + код) и серверы только с keyboard-interactive.
    this.steps.push({ kind: 'kbd' });
  }

  /** ssh2 authHandler: асинхронно выбираем следующий способ. */
  handler = (methodsLeft: AuthenticationType[] | null, partial: boolean | null, next: NextAuthHandler): void => {
    this.nextMethod(methodsLeft ?? null, partial === true)
      .then((method) => next((method ?? false) as never))
      .catch((err) => {
        this.lastError = friendlyMessage(err);
        next(false as never);
      });
  };

  /** Сохраняем введённое «запомнить» только после успешного входа. */
  commit(): void {
    if (this.rememberPassword !== null) {
      try { this.ctx.store.setPassword(this.server.id, this.rememberPassword); } catch { /* ignore */ }
    }
    if (this.rememberPassphrase !== null && this.server.keyID) {
      try { this.ctx.store.setPassphrase(this.server.keyID, this.rememberPassphrase); } catch { /* ignore */ }
    }
  }

  failureError(): Error {
    if (this.cancelled) return new UserFacingError('Подключение отменено.');
    if (this.lastError) return new UserFacingError(this.lastError);
    if (this.keyError && this.serverForbidsPassword) return new UserFacingError(this.keyError);
    if (this.serverForbidsPassword && this.server.auth === 'password') {
      return new UserFacingError('Сервер не разрешает вход по паролю — используйте SSH-ключ.');
    }
    if (this.triedKey && this.server.auth === 'key') return new UserFacingError('Сервер не принял ключ.');
    return new UserFacingError('Неверный логин, пароль или ключ.');
  }

  private allows(methods: AuthenticationType[] | null, ...names: AuthenticationType[]): boolean {
    if (!methods) return true; // первая попытка — список ещё неизвестен
    return names.some((n) => methods.includes(n));
  }

  private async nextMethod(methods: AuthenticationType[] | null, partial: boolean): Promise<AnyAuthMethod | false> {
    if (this.cancelled) return false;
    if (partial) {
      // Первый фактор принят (например, пароль) — дальше только второй (код), повторы пароля не нужны.
      this.steps = this.steps.filter((s) => !(s.kind === 'password' && s.reason === 'retry'));
    }
    if (methods && !methods.includes('password') && !methods.includes('keyboard-interactive')) {
      this.serverForbidsPassword = true;
    }
    while (this.steps.length) {
      const step = this.steps.shift()!;
      switch (step.kind) {
        case 'key': {
          if (!this.allows(methods, 'publickey')) continue;
          const key = await this.loadKey();
          if (this.cancelled) return false;
          if (!key) continue;
          this.triedKey = true;
          this.lastWasPassword = false;
          return { type: 'publickey', username: this.username, key };
        }
        case 'agent': {
          if (!this.allows(methods, 'publickey')) continue;
          this.lastWasPassword = false;
          return { type: 'agent', username: this.username, agent: step.path };
        }
        case 'password': {
          if (!this.allows(methods, 'password', 'keyboard-interactive')) continue;
          let password = step.known;
          // Первую попытку отправили «паролем», а сервер принимает только keyboard-interactive —
          // пароль не проверялся, повторяем его же через keyboard-interactive без вопроса.
          if (password === null && step.reason === 'retry' && this.lastWasPassword && this.currentPassword !== null
              && methods && !methods.includes('password') && methods.includes('keyboard-interactive')) {
            password = this.currentPassword;
            this.passwordAttempts--;
          }
          if (password === null) {
            const title = step.reason === 'retry'
              ? `Неверный пароль. Пароль для ${this.label}`
              : step.reason === 'fallback'
                ? `${this.server.auth === 'key' ? 'Ключ не подошёл' : 'Агент не подошёл'}. Пароль для ${this.label}`
                : `Пароль для ${this.label}`;
            const answer = await this.ask({ kind: 'password', title, prompts: [{ prompt: 'Пароль', echo: false }], canRemember: true });
            if (!answer) {
              this.cancelled = true;
              return false;
            }
            password = answer.value;
            this.rememberPassword = answer.remember ? password : null;
          }
          this.currentPassword = password;
          this.passwordAttempts++;
          if (this.passwordAttempts < 3) {
            // Если пароль не подойдёт — спросим ещё раз.
            this.steps.unshift({ kind: 'password', known: null, reason: 'retry' });
          }
          if (methods && !methods.includes('password')) {
            this.lastWasPassword = false;
            return this.keyboardInteractive(password);
          }
          this.lastWasPassword = true;
          return { type: 'password', username: this.username, password };
        }
        case 'kbd': {
          if (!methods || !methods.includes('keyboard-interactive')) continue;
          this.lastWasPassword = false;
          return this.keyboardInteractive(this.currentPassword);
        }
      }
    }
    return false;
  }

  private keyboardInteractive(autoPassword: string | null): AnyAuthMethod {
    this.kbdAutoUsed = false;
    return {
      type: 'keyboard-interactive',
      username: this.username,
      prompt: (name: string, instructions: string, _lang: string, prompts: Prompt[], finish: (answers: string[]) => void) => {
        if (!prompts.length) {
          finish([]);
          return;
        }
        const looksLikePassword = prompts.length === 1 && !prompts[0].echo && /pass|парол/i.test(prompts[0].prompt);
        if (autoPassword !== null && looksLikePassword && !this.kbdAutoUsed) {
          this.kbdAutoUsed = true;
          finish([autoPassword]);
          return;
        }
        const title = [name, instructions].map((s) => (s ?? '').trim()).filter(Boolean).join(' — ') || `Вход на ${this.label}`;
        this.deadline.pause();
        this.broker.askAuth({
          serverId: this.server.id,
          title,
          kind: 'keyboard-interactive',
          prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
          canRemember: false,
        }).then((answer) => {
          this.deadline.resume();
          if (!answer.answers) {
            this.cancelled = true;
            finish(prompts.map(() => ''));
            return;
          }
          finish(prompts.map((_, i) => answer.answers![i] ?? ''));
        }).catch(() => {
          this.deadline.resume();
          this.cancelled = true;
          finish(prompts.map(() => ''));
        });
      },
    };
  }

  private async ask(prompt: { kind: 'password' | 'passphrase'; title: string; prompts: { prompt: string; echo: boolean }[]; canRemember: boolean }): Promise<{ value: string; remember: boolean } | null> {
    this.deadline.pause();
    try {
      const answer = await this.broker.askAuth({ serverId: this.server.id, ...prompt });
      if (!answer.answers) return null;
      return { value: answer.answers[0] ?? '', remember: answer.remember };
    } catch {
      return null;
    } finally {
      this.deadline.resume();
    }
  }

  /** Загружаем приватный ключ; при необходимости спрашиваем пароль ключа (до 3 раз). */
  private async loadKey(): Promise<ParsedKey | null> {
    if (this.parsedKey) return this.parsedKey;
    const keyId = this.server.keyID;
    if (!keyId) {
      this.keyError = 'Для этого сервера не выбран SSH-ключ.';
      return null;
    }
    const pem = this.ctx.store.privateKey(keyId);
    if (!pem) {
      this.keyError = 'Ключ не найден. Выберите ключ заново в настройках сервера.';
      return null;
    }
    let passphrase = this.ctx.store.passphrase(keyId);
    for (let attempt = 0; attempt < 4; attempt++) {
      const parsed = parseKey(pem, passphrase ?? undefined);
      if (!(parsed instanceof Error)) {
        this.parsedKey = parsed;
        return parsed;
      }
      const needsPassphrase = /passphrase|encrypted|decrypt|bad decrypt/i.test(parsed.message);
      if (!needsPassphrase || attempt === 3) {
        this.keyError = needsPassphrase ? 'Неверный пароль от ключа.' : `Не удалось прочитать ключ: ${parsed.message}`;
        return null;
      }
      const answer = await this.ask({
        kind: 'passphrase',
        title: passphrase ? 'Неверный пароль ключа. Попробуйте ещё раз' : `Пароль ключа для ${this.label}`,
        prompts: [{ prompt: 'Пароль ключа', echo: false }],
        canRemember: true,
      });
      if (!answer) {
        this.cancelled = true;
        return null;
      }
      passphrase = answer.value;
      this.rememberPassphrase = answer.remember ? passphrase : null;
    }
    return null;
  }
}

function parseKey(pem: string, passphrase?: string): ParsedKey | Error {
  try {
    const result = utils.parseKey(pem.trim(), passphrase) as ParsedKey | ParsedKey[] | Error;
    if (Array.isArray(result)) return result[0] ?? new Error('Пустой ключ');
    return result;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Где искать ssh-agent. */
function agentPaths(): string[] {
  if (process.platform === 'win32') {
    return ['\\\\.\\pipe\\openssh-ssh-agent', 'pageant'];
  }
  return process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : [];
}
