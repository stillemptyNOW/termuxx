// Запросы к пользователю из main-процесса: «Доверять ключу сервера?» и пароли/коды.
// main → renderer: IPC.hostKeyPrompt / IPC.authPrompt (через ctx.broadcast)
// renderer → main: IPC.hostKeyAnswer / IPC.authAnswer
import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { IPC } from '../shared/api';
import type { AuthAnswer, AuthPrompt, HostKeyPrompt } from '../shared/types';
import type { MainContext } from './contracts';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PromptBroker {
  private hostKeyRequests = new Map<string, Pending<boolean>>();
  private authRequests = new Map<string, Pending<AuthAnswer>>();
  private registered = false;

  constructor(private readonly ctx: MainContext, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  /** Подписывается на ответы renderer. Безопасно вызывать повторно. */
  register(): void {
    if (this.registered) return;
    this.registered = true;

    // Принимаем и send(), и invoke(); и позиционные аргументы, и объект.
    const onHostKey = (_e: unknown, a: unknown, b?: unknown) => {
      if (a && typeof a === 'object') {
        const o = a as { requestId?: string; accept?: boolean };
        this.answerHostKey(String(o.requestId ?? ''), o.accept === true);
      } else {
        this.answerHostKey(String(a ?? ''), b === true);
      }
    };
    const onAuth = (_e: unknown, a: unknown, b?: unknown) => {
      if (a && typeof a === 'object') {
        const o = a as { requestId?: string; answer?: AuthAnswer; answers?: string[] | null; remember?: boolean };
        const answer: AuthAnswer = o.answer ?? { answers: o.answers ?? null, remember: o.remember === true };
        this.answerAuth(String(o.requestId ?? ''), answer);
      } else {
        const answer = (b && typeof b === 'object') ? (b as AuthAnswer) : { answers: null, remember: false };
        this.answerAuth(String(a ?? ''), answer);
      }
    };
    ipcMain.on(IPC.hostKeyAnswer, onHostKey);
    ipcMain.on(IPC.authAnswer, onAuth);
    safeHandle(IPC.hostKeyAnswer, (e, a, b) => { onHostKey(e, a, b); });
    safeHandle(IPC.authAnswer, (e, a, b) => { onAuth(e, a, b); });
  }

  /** Спросить, доверять ли ключу сервера. true — доверять. */
  askHostKey(info: Omit<HostKeyPrompt, 'requestId'>): Promise<boolean> {
    if (!this.ctx.mainWindow()) {
      return Promise.reject(new Error('Нет окна, чтобы подтвердить ключ сервера.'));
    }
    const requestId = randomUUID();
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.hostKeyRequests.delete(requestId);
        reject(new Error('Нет ответа на запрос о ключе сервера.'));
      }, this.timeoutMs);
      this.hostKeyRequests.set(requestId, { resolve, reject, timer });
      const prompt: HostKeyPrompt = { requestId, ...info };
      this.ctx.broadcast(IPC.hostKeyPrompt, prompt);
    });
  }

  /** Спросить пароль/фразу/коды. answers === null — пользователь отменил. */
  askAuth(info: Omit<AuthPrompt, 'requestId'>): Promise<AuthAnswer> {
    if (!this.ctx.mainWindow()) {
      return Promise.reject(new Error('Нет окна, чтобы спросить пароль.'));
    }
    const requestId = randomUUID();
    return new Promise<AuthAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.authRequests.delete(requestId);
        reject(new Error('Нет ответа на запрос пароля.'));
      }, this.timeoutMs);
      this.authRequests.set(requestId, { resolve, reject, timer });
      const prompt: AuthPrompt = { requestId, ...info };
      this.ctx.broadcast(IPC.authPrompt, prompt);
    });
  }

  answerHostKey(requestId: string, accept: boolean): void {
    const pending = this.hostKeyRequests.get(requestId);
    if (!pending) return;
    this.hostKeyRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(accept);
  }

  answerAuth(requestId: string, answer: AuthAnswer): void {
    const pending = this.authRequests.get(requestId);
    if (!pending) return;
    this.authRequests.delete(requestId);
    clearTimeout(pending.timer);
    const answers = Array.isArray(answer?.answers) ? answer.answers.map((a) => String(a ?? '')) : null;
    pending.resolve({ answers, remember: answer?.remember === true });
  }

  /** Отменить все ожидающие запросы (при выходе). */
  cancelAll(): void {
    for (const [, p] of this.hostKeyRequests) { clearTimeout(p.timer); p.resolve(false); }
    for (const [, p] of this.authRequests) { clearTimeout(p.timer); p.resolve({ answers: null, remember: false }); }
    this.hostKeyRequests.clear();
    this.authRequests.clear();
  }
}

/** ipcMain.handle, который не падает, если канал уже зарегистрирован кем-то ещё. */
function safeHandle(channel: string, fn: (e: unknown, a: unknown, b?: unknown) => unknown): void {
  try {
    ipcMain.handle(channel, (e, a, b) => fn(e, a, b));
  } catch {
    // Уже есть обработчик invoke — достаточно ipcMain.on.
  }
}
