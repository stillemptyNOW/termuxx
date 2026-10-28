// Глобальные запросы от main-процесса: доверие к ключу сервера и ввод пароля / passphrase.
import React, { useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, ShieldAlert, ShieldQuestion } from 'lucide-react';
import type { AuthPrompt, HostKeyPrompt } from '../../shared/types';
import { Button, Dialog, Toggle, toast } from '../ui/kit';
import { api } from './util';

type Item = { type: 'hostKey'; prompt: HostKeyPrompt } | { type: 'auth'; prompt: AuthPrompt };

export function PromptHost() {
  const [queue, setQueue] = useState<Item[]>([]);

  useEffect(() => {
    const offKey = api().onHostKeyPrompt((prompt) => setQueue((q) => [...q, { type: 'hostKey', prompt }]));
    const offAuth = api().onAuthPrompt((prompt) => setQueue((q) => [...q, { type: 'auth', prompt }]));
    return () => { offKey(); offAuth(); };
  }, []);

  const current = queue[0];
  if (!current) return null;
  const pop = () => setQueue((q) => q.slice(1));

  if (current.type === 'hostKey') {
    return (
      <HostKeyDialog
        key={current.prompt.requestId}
        prompt={current.prompt}
        onAnswer={(accept) => { api().answerHostKey(current.prompt.requestId, accept); pop(); }}
      />
    );
  }
  return (
    <AuthDialog
      key={current.prompt.requestId}
      prompt={current.prompt}
      onAnswer={(answers, remember) => { api().answerAuth(current.prompt.requestId, { answers, remember }); pop(); }}
    />
  );
}

function HostKeyDialog({ prompt, onAnswer }: { prompt: HostKeyPrompt; onAnswer: (accept: boolean) => void }) {
  const answered = useRef(false);
  const answer = (accept: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(accept);
  };
  const target = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;

  return (
    <Dialog
      title={prompt.changed ? 'Ключ сервера изменился!' : 'Новый сервер'}
      icon={prompt.changed ? <ShieldAlert size={20} color="var(--danger)" /> : <ShieldQuestion size={20} className="tx-accent" />}
      onClose={() => answer(false)}
      footer={<>
        <Button onClick={() => answer(false)} autoFocus={prompt.changed}>Отмена</Button>
        <Button variant={prompt.changed ? 'danger-solid' : 'primary'} onClick={() => answer(true)} autoFocus={!prompt.changed}>
          {prompt.changed ? 'Всё равно доверять' : 'Доверять и подключиться'}
        </Button>
      </>}
    >
      <div className="col" style={{ gap: 12 }}>
        {prompt.changed ? (
          <div className="tx-danger-box">
            <b>Возможна подмена сервера.</b> Ключ <span className="mono">{target}</span> отличается от сохранённого.
            Если вы не переустанавливали сервер и не меняли его ключи — не подключайтесь.
          </div>
        ) : (
          <div>
            Вы подключаетесь к <span className="mono">{target}</span> впервые. Проверьте отпечаток ключа:
            он должен совпадать с выводом команды на сервере.
          </div>
        )}
        <div className="tx-fp">
          <div className="faint">{prompt.keyType}</div>
          <div className="mono tx-fp-value">{prompt.fingerprint}</div>
          <button className="icon-btn" title="Копировать" onClick={() => { api().clipboardWrite(prompt.fingerprint); toast('Отпечаток скопирован'); }}>
            <Copy size={14} />
          </button>
        </div>
        {prompt.changed && prompt.previous && (
          <div className="tx-fp old">
            <div className="faint">Был сохранён</div>
            <div className="mono tx-fp-value">{prompt.previous}</div>
          </div>
        )}
        <div className="faint">
          Проверить на сервере: <span className="mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>
        </div>
      </div>
    </Dialog>
  );
}

function AuthDialog({ prompt, onAnswer }: { prompt: AuthPrompt; onAnswer: (answers: string[] | null, remember: boolean) => void }) {
  const prompts = prompt.prompts.length > 0
    ? prompt.prompts
    : [{ prompt: prompt.kind === 'passphrase' ? 'Пароль от ключа' : 'Пароль', echo: false }];
  const [values, setValues] = useState<string[]>(() => prompts.map(() => ''));
  const [remember, setRemember] = useState(false);
  const answered = useRef(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  const answer = (submit: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(submit ? values : null, submit && remember);
  };

  const label = (p: string) => p.replace(/:\s*$/, '');

  return (
    <Dialog
      title={prompt.title}
      icon={<KeyRound size={18} className="tx-accent" />}
      onClose={() => answer(false)}
      footer={<>
        <Button onClick={() => answer(false)}>Отмена</Button>
        <Button variant="primary" onClick={() => answer(true)}>Подключиться</Button>
      </>}
    >
      <form className="col" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); answer(true); }}>
        {prompt.kind === 'keyboard-interactive' && prompts.length > 1 && (
          <div className="muted">Сервер запрашивает дополнительные данные.</div>
        )}
        {prompts.map((p, i) => (
          <div key={i} className="field">
            <label>{label(p.prompt)}</label>
            <input
              ref={i === 0 ? firstRef : undefined}
              className="input"
              type={p.echo ? 'text' : 'password'}
              value={values[i] ?? ''}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </div>
        ))}
        {prompt.canRemember && (
          <Toggle
            checked={remember}
            onChange={setRemember}
            label={prompt.kind === 'passphrase' ? 'Запомнить пароль от ключа' : 'Запомнить пароль'}
            hint="Хранится в зашифрованном виде (Windows DPAPI)"
          />
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
