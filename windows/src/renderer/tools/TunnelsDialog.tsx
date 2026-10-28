// Проброс портов: локальный (-L), удалённый (-R) и динамический SOCKS (-D) поверх SSH-сессии.
import React, { useEffect, useMemo, useState } from 'react';
import { Cable, Copy, ExternalLink, Globe, Pencil, Plus, Trash2, Waypoints } from 'lucide-react';
import type { ForwardType, PortForward, Server, TunnelState } from '../../shared/types';
import { Button, Dialog, Field, IconButton, NumberInput, Segmented, TextInput, Toggle, cx, formatBytes, plural, toast } from '../ui/kit';
import { ConfirmDialog } from './dialogs';
import { api, errorText } from './util';

export interface TunnelsDialogProps {
  sessionId: string;
  server: Server;
  onClose: () => void;
  onSaveServer: (s: Server) => void;
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  const id = c && typeof c.randomUUID === 'function'
    ? c.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  return id.toUpperCase();
}

const typeOf = (f: PortForward): ForwardType => f.type ?? 'local';

/** Человекочитаемая схема туннеля. */
export function describeForward(f: PortForward): string {
  switch (typeOf(f)) {
    case 'remote': return `сервер:${f.remotePort} → 127.0.0.1:${f.localPort}`;
    case 'dynamic': return `SOCKS5 на 127.0.0.1:${f.localPort}`;
    default: return `127.0.0.1:${f.localPort} → ${f.remoteHost}:${f.remotePort}`;
  }
}

const TYPE_BADGE: Record<ForwardType, string> = { local: 'L', remote: 'R', dynamic: 'D' };

const PRESETS: { name: string; f: Partial<PortForward> }[] = [
  { name: 'Веб-панель', f: { type: 'local', localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80 } },
  { name: 'HTTPS', f: { type: 'local', localPort: 8443, remoteHost: '127.0.0.1', remotePort: 443 } },
  { name: 'PostgreSQL', f: { type: 'local', localPort: 15432, remoteHost: '127.0.0.1', remotePort: 5432 } },
  { name: 'MySQL', f: { type: 'local', localPort: 13306, remoteHost: '127.0.0.1', remotePort: 3306 } },
  { name: 'Redis', f: { type: 'local', localPort: 16379, remoteHost: '127.0.0.1', remotePort: 6379 } },
  { name: 'SOCKS-прокси', f: { type: 'dynamic', localPort: 1080, remoteHost: '', remotePort: 0 } },
];

export function TunnelsDialog({ sessionId, server, onClose, onSaveServer }: TunnelsDialogProps) {
  const [forwards, setForwards] = useState<PortForward[]>(server.forwards ?? []);
  const [states, setStates] = useState<TunnelState[]>([]);
  const [editing, setEditing] = useState<{ forward: PortForward; isNew: boolean } | null>(null);
  const [deleting, setDeleting] = useState<PortForward | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());

  useEffect(() => { setForwards(server.forwards ?? []); }, [server]);

  useEffect(() => {
    let alive = true;
    api().tunnelList().then((list) => { if (alive) setStates(list); }).catch(() => undefined);
    const off = api().onTunnels((list) => setStates(list));
    return () => { alive = false; off(); };
  }, []);

  const stateOf = useMemo(() => {
    const map = new Map<string, TunnelState>();
    states.forEach((s) => map.set(s.id, s));
    return map;
  }, [states]);

  const persist = (next: PortForward[]) => {
    setForwards(next);
    onSaveServer({ ...server, forwards: next });
  };

  const isRunning = (id: string) => {
    const st = stateOf.get(id)?.status;
    return st === 'active' || st === 'starting';
  };

  const setBusy = (id: string, on: boolean) => setPending((p) => {
    const n = new Set(p);
    if (on) n.add(id); else n.delete(id);
    return n;
  });

  const start = async (f: PortForward) => {
    setBusy(f.id, true);
    try {
      await api().tunnelStart(sessionId, f);
    } catch (err) {
      toast(`Туннель ${f.localPort}: ${errorText(err)}`, 'error');
    } finally {
      setBusy(f.id, false);
    }
  };

  const stop = async (f: PortForward) => {
    setBusy(f.id, true);
    try {
      await api().tunnelStop(f.id);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(f.id, false);
    }
  };

  const toggle = (f: PortForward, on: boolean) => { void (on ? start(f) : stop(f)); };

  const saveForward = async (f: PortForward, isNew: boolean) => {
    const next = isNew ? [...forwards, f] : forwards.map((x) => (x.id === f.id ? f : x));
    persist(next);
    setEditing(null);
    if (isNew || isRunning(f.id)) {
      if (isRunning(f.id)) await stop(f);
      await start(f);
    }
  };

  const activeCount = states.filter((s) => s.status === 'active' && forwards.some((f) => f.id === s.id)).length;

  return (
    <Dialog
      title={<span className="row" style={{ gap: 10 }}>Туннели<span className="faint" style={{ fontWeight: 400 }}>{server.name || server.hostname}</span></span>}
      icon={<Waypoints size={18} className="tx-accent" />}
      size="wide"
      onClose={() => { if (!editing && !deleting) onClose(); }}
      footer={<>
        <span className="faint grow">
          {activeCount > 0 ? `Активно: ${activeCount}` : 'Туннели работают, пока открыта SSH-сессия.'}
        </span>
        <Button icon={<Plus size={14} />} onClick={() => setEditing({ forward: { id: newId(), name: '', type: 'local', localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, autoStart: true }, isNew: true })}>
          Добавить туннель
        </Button>
        <Button variant="primary" onClick={onClose}>Готово</Button>
      </>}
    >
      <p className="muted tx-tunnels-intro">
        Локальный туннель открывает порт на этом компьютере (127.0.0.1) и ведёт через SSH на адрес со стороны сервера —
        удобно для веб-панелей и баз данных, закрытых от интернета. SOCKS-прокси пускает браузер в сеть через сервер.
      </p>

      {forwards.length === 0 ? (
        <div className="tx-tunnels-empty">
          <Cable size={30} className="faint" />
          <div className="tx-confirm-title">Туннелей пока нет</div>
          <div className="faint">Например: локальный 8080 → 127.0.0.1:80 откроет веб-панель сервера по адресу http://127.0.0.1:8080</div>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
            {PRESETS.map((p) => (
              <button
                key={p.name}
                className="btn small"
                onClick={() => setEditing({ forward: { id: newId(), name: p.name, localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, autoStart: true, ...p.f } as PortForward, isNew: true })}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="tx-tunnels">
          {forwards.map((f) => {
            const st = stateOf.get(f.id);
            const running = isRunning(f.id);
            const type = typeOf(f);
            const url = `http://127.0.0.1:${f.localPort}`;
            return (
              <div key={f.id} className={cx('tx-tunnel', running && 'on', st?.status === 'error' && 'err')}>
                <span className={cx('tx-tunnel-type', type)}>{TYPE_BADGE[type]}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="tx-tunnel-title ellipsis">{f.name || describeForward(f)}</div>
                  <div className="mono faint ellipsis">{describeForward(f)}{f.autoStart ? ' · автозапуск' : ''}</div>
                  <div className="tx-tunnel-state">
                    {st?.status === 'error' && <span className="tx-error-text">Ошибка: {st.error || 'не удалось открыть порт'}</span>}
                    {st?.status === 'starting' && <span className="muted">Запуск…</span>}
                    {st?.status === 'active' && (
                      <span className="tx-accent">
                        Активен · {st.connections} {plural(st.connections, 'подключение', 'подключения', 'подключений')}
                        <span className="faint"> · ↓ {formatBytes(st.bytesIn)} ↑ {formatBytes(st.bytesOut)}</span>
                      </span>
                    )}
                    {(!st || st.status === 'stopped') && <span className="faint">Остановлен</span>}
                  </div>
                </div>
                {type !== 'remote' && running && (
                  <>
                    {type === 'local' && (
                      <IconButton title={`Открыть ${url}`} onClick={() => api().openExternal(url)}><ExternalLink size={15} /></IconButton>
                    )}
                    <IconButton
                      title="Копировать адрес"
                      onClick={() => {
                        api().clipboardWrite(type === 'dynamic' ? `socks5://127.0.0.1:${f.localPort}` : url);
                        toast('Адрес скопирован');
                      }}
                    >
                      {type === 'dynamic' ? <Globe size={15} /> : <Copy size={15} />}
                    </IconButton>
                  </>
                )}
                <IconButton title="Изменить" onClick={() => setEditing({ forward: f, isNew: false })}><Pencil size={14} /></IconButton>
                <IconButton title="Удалить" onClick={() => setDeleting(f)}><Trash2 size={14} /></IconButton>
                <span className={cx(pending.has(f.id) && 'tx-pending')}>
                  <Toggle checked={running} onChange={(on) => toggle(f, on)} />
                </span>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ForwardEditor
          initial={editing.forward}
          isNew={editing.isNew}
          others={forwards.filter((x) => x.id !== editing.forward.id)}
          onCancel={() => setEditing(null)}
          onSave={(f) => void saveForward(f, editing.isNew)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Удалить туннель?"
          message={<>{deleting.name || describeForward(deleting)}</>}
          confirmText="Удалить"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const f = deleting;
            setDeleting(null);
            if (isRunning(f.id)) await stop(f);
            persist(forwards.filter((x) => x.id !== f.id));
          }}
        />
      )}
    </Dialog>
  );
}

function portError(p: number): string | null {
  if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Порт от 1 до 65535';
  return null;
}

function ForwardEditor({ initial, isNew, others, onCancel, onSave }: {
  initial: PortForward;
  isNew: boolean;
  others: PortForward[];
  onCancel: () => void;
  onSave: (f: PortForward) => void;
}) {
  const [f, setF] = useState<PortForward>({ ...initial, type: initial.type ?? 'local' });
  const type = typeOf(f);
  const set = <K extends keyof PortForward>(k: K, v: PortForward[K]) => setF((x) => ({ ...x, [k]: v }));

  const localErr = portError(f.localPort)
    ?? (type !== 'remote' && others.some((o) => typeOf(o) !== 'remote' && o.localPort === f.localPort) ? 'Этот порт уже занят другим туннелем' : null);
  const remoteErr = type === 'dynamic' ? null : portError(f.remotePort);
  const hostErr = type === 'local' && !f.remoteHost.trim() ? 'Укажите адрес' : null;
  const valid = !localErr && !remoteErr && !hostErr;

  return (
    <Dialog
      title={isNew ? 'Новый туннель' : 'Изменить туннель'}
      icon={<Cable size={18} className="tx-accent" />}
      onClose={onCancel}
      footer={<>
        <Button onClick={onCancel}>Отмена</Button>
        <Button
          variant="primary"
          disabled={!valid}
          onClick={() => onSave({ ...f, name: f.name.trim(), remoteHost: type === 'dynamic' ? '' : f.remoteHost.trim() || '127.0.0.1' })}
        >
          {isNew ? 'Добавить и запустить' : 'Сохранить'}
        </Button>
      </>}
    >
      <div className="col" style={{ gap: 12 }}>
        <Segmented<ForwardType>
          value={type}
          onChange={(v) => set('type', v)}
          options={[
            { value: 'local', label: 'Локальный (-L)' },
            { value: 'remote', label: 'Удалённый (-R)' },
            { value: 'dynamic', label: 'SOCKS (-D)' },
          ]}
        />
        <Field label="Название" hint="Необязательно, например «Панель X-UI»">
          <TextInput value={f.name} onChange={(v) => set('name', v)} placeholder={describeForward(f)} />
        </Field>
        {type === 'local' && (
          <>
            <Field label="Порт на этом компьютере" hint={localErr ?? `Откроется как http://127.0.0.1:${f.localPort}`}>
              <NumberInput value={f.localPort} min={1} max={65535} onChange={(v) => set('localPort', v)} />
            </Field>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div className="grow">
                <Field label="Адрес со стороны сервера" hint={hostErr ?? '127.0.0.1 — сам сервер; можно указать другой адрес из его сети'}>
                  <TextInput value={f.remoteHost} onChange={(v) => set('remoteHost', v)} />
                </Field>
              </div>
              <div style={{ width: 130 }}>
                <Field label="Порт" hint={remoteErr ?? undefined}>
                  <NumberInput value={f.remotePort} min={1} max={65535} onChange={(v) => set('remotePort', v)} />
                </Field>
              </div>
            </div>
          </>
        )}
        {type === 'remote' && (
          <>
            <Field label="Порт на сервере" hint={remoteErr ?? 'Сервер начнёт слушать этот порт на 127.0.0.1'}>
              <NumberInput value={f.remotePort} min={1} max={65535} onChange={(v) => set('remotePort', v)} />
            </Field>
            <Field label="Порт на этом компьютере" hint={localErr ?? 'Куда пересылать подключения (127.0.0.1)'}>
              <NumberInput value={f.localPort} min={1} max={65535} onChange={(v) => set('localPort', v)} />
            </Field>
          </>
        )}
        {type === 'dynamic' && (
          <Field label="Порт SOCKS5-прокси" hint={localErr ?? `Укажите в браузере прокси socks5://127.0.0.1:${f.localPort}`}>
            <NumberInput value={f.localPort} min={1} max={65535} onChange={(v) => set('localPort', v)} />
          </Field>
        )}
        <Toggle checked={f.autoStart} onChange={(v) => set('autoStart', v)} label="Запускать при подключении" hint="Туннель откроется сразу после входа на сервер" />
      </div>
    </Dialog>
  );
}
