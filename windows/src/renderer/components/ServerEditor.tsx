import React, { useEffect, useMemo, useState } from 'react';
import { Check, KeyRound, Monitor, Plus, Server as ServerIcon, Trash, Upload, Wand2 } from 'lucide-react';
import type { ForwardType, PortForward, Server } from '../../shared/types';
import { blankServer, errorText, newUUID, SERVER_COLORS, useApp } from '../state';
import {
  Button, Dialog, Field, IconButton, NumberInput, Segmented, Select, TextArea, TextInput, Toggle, cx, toast,
} from '../ui/kit';
import { saveServer } from './actions';
import { openServer } from './sessions';

type Section = 'main' | 'auth' | 'route' | 'tunnels' | 'more';

function validPort(p: number) { return Number.isInteger(p) && p > 0 && p < 65536; }

export function ServerEditor({ serverId, initial, onClose }: { serverId?: string; initial?: Partial<Server>; onClose: () => void }) {
  const existing = useApp((s) => (serverId ? s.server(serverId) : undefined));
  const hosts = useApp((s) => s.data?.hosts) ?? [];
  const keys = useApp((s) => s.data?.keys) ?? [];
  const snippets = useApp((s) => s.data?.snippets) ?? [];
  const isNew = !existing;

  const [draft, setDraft] = useState<Server>(() => (existing ? { ...existing, forwards: existing.forwards.map((f) => ({ ...f })) } : blankServer(initial)));
  const [section, setSection] = useState<Section>('main');
  const [password, setPassword] = useState('');
  const [passwordDirty, setPasswordDirty] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [proxyOn, setProxyOn] = useState(!!draft.proxy);
  const [proxyPassword, setProxyPassword] = useState('');
  const [proxyPasswordDirty, setProxyPasswordDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (existing) void window.termuxx.hasPassword(existing.id).then(setHasSaved).catch(() => setHasSaved(false));
  }, [existing]);

  const set = <K extends keyof Server>(key: K, value: Server[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const isRdp = draft.protocol === 'rdp';
  const groups = useMemo(() => [...new Set(hosts.map((h) => h.group).filter((g): g is string => !!g))].sort(), [hosts]);

  const errors = useMemo(() => {
    const e: Partial<Record<'hostname' | 'port' | 'username' | 'key' | 'proxy' | 'forwards' | 'jump', string>> = {};
    if (!draft.hostname.trim()) e.hostname = 'Укажите адрес сервера';
    else if (/\s/.test(draft.hostname.trim())) e.hostname = 'Адрес не должен содержать пробелов';
    if (!validPort(draft.port)) e.port = 'Порт 1–65535';
    if (!isRdp && !draft.username.trim()) e.username = 'Укажите пользователя';
    if (!isRdp && draft.auth === 'key' && !draft.keyID) e.key = 'Выберите ключ';
    if (proxyOn && (!draft.proxy?.host.trim() || !validPort(draft.proxy?.port ?? 0))) e.proxy = 'Укажите адрес и порт прокси';
    if (draft.jumpHostID && draft.jumpHostID === draft.id) e.jump = 'Сервер не может быть промежуточным сам для себя';
    const seen = new Set<number>();
    for (const f of draft.forwards) {
      const t = f.type ?? 'local';
      if (!validPort(f.localPort) || (t !== 'dynamic' && (!f.remoteHost.trim() || !validPort(f.remotePort)))) {
        e.forwards = 'Проверьте порты и адреса туннелей';
        break;
      }
      if (t !== 'remote') {
        if (seen.has(f.localPort)) { e.forwards = `Локальный порт ${f.localPort} указан дважды`; break; }
        seen.add(f.localPort);
      }
    }
    return e;
  }, [draft, isRdp, proxyOn]);
  const hasErrors = Object.keys(errors).length > 0;

  const sectionErrors: Record<Section, boolean> = {
    main: !!(errors.hostname || errors.port || errors.username),
    auth: !!errors.key,
    route: !!(errors.proxy || errors.jump),
    tunnels: !!errors.forwards,
    more: false,
  };

  const setProtocol = (p: 'ssh' | 'rdp') => {
    setDraft((d) => {
      let port = d.port;
      if (p === 'rdp' && port === 22) port = 3389;
      if (p === 'ssh' && port === 3389) port = 22;
      return { ...d, protocol: p, port };
    });
  };

  const save = async (connect: boolean) => {
    if (hasErrors) {
      setShowErrors(true);
      const first = (Object.keys(sectionErrors) as Section[]).find((k) => sectionErrors[k]);
      if (first) setSection(first);
      return;
    }
    setSaving(true);
    const server: Server = {
      ...draft,
      name: draft.name.trim(),
      hostname: draft.hostname.trim(),
      username: draft.username.trim() || (isRdp ? '' : 'root'),
      group: draft.group?.trim() || null,
      proxy: proxyOn && draft.proxy ? { ...draft.proxy, host: draft.proxy.host.trim(), username: draft.proxy.username.trim() } : null,
      keyID: draft.auth === 'key' ? draft.keyID ?? null : draft.keyID ?? null,
    };
    try {
      await saveServer(server);
      if (passwordDirty) await window.termuxx.setPassword(server.id, password ? password : null);
      if (proxyPasswordDirty) await window.termuxx.setProxyPassword(server.id, proxyPassword ? proxyPassword : null);
      toast(isNew ? 'Сервер добавлен' : 'Сохранено', 'success');
      onClose();
      if (connect) void openServer(server);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const generateKey = async () => {
    try {
      const item = await window.termuxx.generateKey(`termuxx-${(draft.name || draft.hostname || 'key').replace(/\s+/g, '-')}`);
      setDraft((d) => ({ ...d, keyID: item.id, auth: 'key' }));
      window.termuxx.clipboardWrite(item.publicKey);
      toast('Ключ создан, публичная часть скопирована. Установите его на сервер в «Настройки → Ключи».', 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const importKey = async () => {
    try {
      const item = await window.termuxx.importKeyFile();
      if (item) setDraft((d) => ({ ...d, keyID: item.id, auth: 'key' }));
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const updateForward = (id: string, patch: Partial<PortForward>) =>
    setDraft((d) => ({ ...d, forwards: d.forwards.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));

  const addForward = (preset?: Partial<PortForward>) =>
    setDraft((d) => ({
      ...d,
      forwards: [...d.forwards, {
        id: newUUID(), name: '', type: 'local', localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, autoStart: true, ...preset,
      }],
    }));

  const err = (k: keyof typeof errors) => (showErrors && errors[k] ? <span className="tx-err">{errors[k]}</span> : null);
  const jumpCandidates = hosts.filter((h) => h.id !== draft.id && h.protocol !== 'rdp');

  return (
    <Dialog
      title={isNew ? 'Новый сервер' : `Сервер: ${existing?.name || existing?.hostname}`}
      icon={<div className="tx-editor-icon" style={{ background: draft.colorHex }}>{isRdp ? <Monitor size={16} /> : <ServerIcon size={16} />}</div>}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          {showErrors && hasErrors && <span className="tx-err grow">Исправьте отмеченные поля</span>}
          <Button onClick={onClose}>Отмена</Button>
          <Button onClick={() => void save(false)} disabled={saving}>Сохранить</Button>
          <Button variant="primary" icon={<Check size={14} />} onClick={() => void save(true)} disabled={saving}>
            Сохранить и подключиться
          </Button>
        </>
      )}
    >
      <div className="tx-editor-tabs">
        {([
          ['main', 'Основное'], ['auth', 'Вход'], ['route', 'Маршрут'], ['tunnels', 'Туннели'], ['more', 'Дополнительно'],
        ] as [Section, string][]).filter(([k]) => !isRdp || k === 'main' || k === 'more').map(([k, label]) => (
          <button key={k} className={cx('tx-editor-tab', section === k && 'on', showErrors && sectionErrors[k] && 'bad')} onClick={() => setSection(k)}>
            {label}
            {k === 'tunnels' && draft.forwards.length > 0 && <span className="badge accent">{draft.forwards.length}</span>}
          </button>
        ))}
      </div>

      {section === 'main' && (
        <div className="tx-form">
          <div className="tx-form-row">
            <Field label="Протокол">
              <Segmented value={isRdp ? 'rdp' : 'ssh'} onChange={setProtocol} options={[
                { value: 'ssh', label: 'SSH' },
                { value: 'rdp', label: 'RDP (удалённый рабочий стол)' },
              ]} />
            </Field>
          </div>
          <div className="tx-form-grid">
            <Field label="Название">
              <TextInput value={draft.name} onChange={(v) => set('name', v)} placeholder={draft.hostname || 'Мой VPS'} autoFocus />
            </Field>
            <Field label="Папка" hint="Для группировки в списке сессий">
              <TextInput value={draft.group ?? ''} onChange={(v) => set('group', v)} placeholder="Без папки" list="tx-editor-groups" />
              <datalist id="tx-editor-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
            </Field>
          </div>
          <div className="tx-form-grid tx-grid-host">
            <Field label="Адрес (IP или домен)">
              <TextInput value={draft.hostname} onChange={(v) => set('hostname', v)} placeholder="203.0.113.10" className={cx(showErrors && errors.hostname && 'tx-input-bad')} />
              {err('hostname')}
            </Field>
            <Field label="Порт">
              <NumberInput value={draft.port} onChange={(v) => set('port', v)} min={1} max={65535} className={cx(showErrors && errors.port && 'tx-input-bad')} />
              {err('port')}
            </Field>
          </div>
          <Field label={isRdp ? 'Пользователь (необязательно)' : 'Пользователь'}>
            <TextInput value={draft.username} onChange={(v) => set('username', v)} placeholder={isRdp ? 'Administrator' : 'root'} className={cx(showErrors && errors.username && 'tx-input-bad')} />
            {err('username')}
          </Field>
          <Field label="Цвет">
            <div className="row">
              {SERVER_COLORS.map((c) => (
                <button key={c} className={cx('tx-swatch', draft.colorHex === c && 'on')} style={{ background: c }} onClick={() => set('colorHex', c)} title={c}>
                  {draft.colorHex === c && <Check size={13} />}
                </button>
              ))}
            </div>
          </Field>
          {isRdp && (
            <div className="tx-note">
              RDP-подключение открывается во встроенном клиенте Windows (mstsc). Пароль можно сохранить в диспетчере учётных данных Windows при первом входе.
            </div>
          )}
        </div>
      )}

      {section === 'auth' && !isRdp && (
        <div className="tx-form">
          <Field label="Способ входа">
            <Segmented value={draft.auth} onChange={(v) => set('auth', v)} options={[
              { value: 'password', label: 'Пароль' },
              { value: 'key', label: 'SSH-ключ' },
              { value: 'agent', label: 'Агент (Pageant / OpenSSH)' },
            ]} />
          </Field>
          {draft.auth === 'password' && (
            <Field label="Пароль" hint={hasSaved && !passwordDirty ? 'Пароль сохранён (зашифрован системой). Введите новый, чтобы заменить.' : 'Пусто — спрашивать при подключении. Хранится зашифрованным (DPAPI).'}>
              <div className="row">
                <TextInput type="password" value={password} onChange={(v) => { setPassword(v); setPasswordDirty(true); }} placeholder={hasSaved && !passwordDirty ? '••••••••' : 'Не сохранён'} className="grow" autoComplete="new-password" />
                {hasSaved && (
                  <Button small variant="danger" onClick={() => { setPassword(''); setPasswordDirty(true); setHasSaved(false); }}>Забыть</Button>
                )}
              </div>
            </Field>
          )}
          {draft.auth === 'key' && (
            <>
              <Field label="Ключ">
                <div className="row">
                  <Select
                    className="grow"
                    value={draft.keyID ?? ''}
                    onChange={(v) => set('keyID', v || null)}
                    options={[{ value: '', label: keys.length ? 'Выберите ключ…' : 'Ключей пока нет' }, ...keys.map((k) => ({ value: k.id, label: `${k.name} · ${k.type}${k.encrypted ? ' · с паролем' : ''}` }))]}
                  />
                  <Button small icon={<Wand2 size={13} />} onClick={() => void generateKey()}>Создать</Button>
                  <Button small icon={<Upload size={13} />} onClick={() => void importKey()}>Импорт</Button>
                </div>
                {err('key')}
              </Field>
              <div className="tx-note"><KeyRound size={14} /> Публичную часть ключа нужно добавить на сервер в ~/.ssh/authorized_keys — это делает кнопка «Установить на сервер» в «Настройки → Ключи».</div>
            </>
          )}
          {draft.auth === 'agent' && (
            <div className="tx-note">Будут использованы ключи из Pageant или службы OpenSSH Authentication Agent Windows (на Linux — SSH_AUTH_SOCK).</div>
          )}
        </div>
      )}

      {section === 'route' && !isRdp && (
        <div className="tx-form">
          <Field label="Промежуточный сервер (jump host)" hint="Подключение пойдёт через выбранный сервер, как ssh -J">
            <Select
              value={draft.jumpHostID ?? ''}
              onChange={(v) => set('jumpHostID', v || null)}
              options={[{ value: '', label: 'Напрямую' }, ...jumpCandidates.map((h) => ({ value: h.id, label: `${h.name || h.hostname} (${h.username}@${h.hostname})` }))]}
            />
            {err('jump')}
          </Field>
          <Toggle checked={proxyOn} onChange={(v) => {
            setProxyOn(v);
            if (v && !draft.proxy) set('proxy', { host: '127.0.0.1', port: 1080, username: '' });
          }} label="Через SOCKS5-прокси" hint="Например, локальный обход блокировок или корпоративный прокси" />
          {proxyOn && (
            <>
              <div className="tx-form-grid tx-grid-host">
                <Field label="Адрес прокси">
                  <TextInput value={draft.proxy?.host ?? ''} onChange={(v) => set('proxy', { host: v, port: draft.proxy?.port ?? 1080, username: draft.proxy?.username ?? '' })} placeholder="127.0.0.1" />
                </Field>
                <Field label="Порт">
                  <NumberInput value={draft.proxy?.port ?? 1080} onChange={(v) => set('proxy', { host: draft.proxy?.host ?? '', port: v, username: draft.proxy?.username ?? '' })} min={1} max={65535} />
                </Field>
              </div>
              <div className="tx-form-grid">
                <Field label="Логин (необязательно)">
                  <TextInput value={draft.proxy?.username ?? ''} onChange={(v) => set('proxy', { host: draft.proxy?.host ?? '', port: draft.proxy?.port ?? 1080, username: v })} />
                </Field>
                <Field label="Пароль прокси">
                  <TextInput type="password" value={proxyPassword} onChange={(v) => { setProxyPassword(v); setProxyPasswordDirty(true); }} placeholder={isNew ? '' : 'Не менять'} autoComplete="new-password" />
                </Field>
              </div>
              {err('proxy')}
            </>
          )}
        </div>
      )}

      {section === 'tunnels' && !isRdp && (
        <div className="tx-form">
          <div className="tx-note">
            Локальный: порт на этом компьютере → адрес со стороны сервера (ssh -L). Удалённый: порт на сервере → адрес здесь (ssh -R).
            Динамический: SOCKS5-прокси на этом компьютере (ssh -D).
          </div>
          {draft.forwards.length === 0 && <div className="faint" style={{ padding: '8px 0' }}>Туннелей нет.</div>}
          {draft.forwards.map((f) => {
            const t: ForwardType = f.type ?? 'local';
            return (
              <div key={f.id} className="tx-fwd">
                <Select value={t} onChange={(v) => updateForward(f.id, { type: v })} className="tx-fwd-type" options={[
                  { value: 'local', label: 'Локальный (-L)' },
                  { value: 'remote', label: 'Удалённый (-R)' },
                  { value: 'dynamic', label: 'SOCKS (-D)' },
                ]} />
                <TextInput value={f.name} onChange={(v) => updateForward(f.id, { name: v })} placeholder="Название" className="tx-fwd-name" />
                <NumberInput value={f.localPort} onChange={(v) => updateForward(f.id, { localPort: v })} min={1} max={65535} className="tx-fwd-port" title={t === 'remote' ? 'Порт на сервере' : 'Порт на этом компьютере'} />
                {t !== 'dynamic' && (
                  <>
                    <span className="faint">→</span>
                    <TextInput value={f.remoteHost} onChange={(v) => updateForward(f.id, { remoteHost: v })} placeholder="127.0.0.1" className="tx-fwd-host" />
                    <span className="faint">:</span>
                    <NumberInput value={f.remotePort} onChange={(v) => updateForward(f.id, { remotePort: v })} min={1} max={65535} className="tx-fwd-port" />
                  </>
                )}
                <label className="row tx-fwd-auto" title="Запускать при подключении">
                  <input type="checkbox" checked={f.autoStart} onChange={(e) => updateForward(f.id, { autoStart: e.target.checked })} /> авто
                </label>
                <IconButton title="Удалить" onClick={() => setDraft((d) => ({ ...d, forwards: d.forwards.filter((x) => x.id !== f.id) }))}><Trash size={14} /></IconButton>
              </div>
            );
          })}
          {err('forwards')}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Button small icon={<Plus size={13} />} onClick={() => addForward()}>Добавить туннель</Button>
            <Button small onClick={() => addForward({ name: 'Веб-панель', localPort: 8080, remotePort: 80 })}>Веб-панель :80</Button>
            <Button small onClick={() => addForward({ name: 'PostgreSQL', localPort: 5433, remotePort: 5432 })}>PostgreSQL</Button>
            <Button small onClick={() => addForward({ name: 'MySQL', localPort: 3307, remotePort: 3306 })}>MySQL</Button>
            <Button small onClick={() => addForward({ name: 'SOCKS-прокси', type: 'dynamic', localPort: 1080, remoteHost: '', remotePort: 0 })}>SOCKS :1080</Button>
          </div>
        </div>
      )}

      {section === 'more' && (
        <div className="tx-form">
          {!isRdp && (
            <>
              <Toggle checked={draft.useTmux} onChange={(v) => set('useTmux', v)} label="Работать через tmux" hint="Сессия переживёт обрыв связи: при переподключении вы окажетесь там же" />
              <Toggle checked={draft.autoReconnect} onChange={(v) => set('autoReconnect', v)} label="Переподключаться автоматически" hint="При обрыве — до 3 попыток" />
              <Toggle checked={draft.keepAlive} onChange={(v) => set('keepAlive', v)} label="Keep-alive" hint="Не даёт роутеру и NAT закрыть простаивающее соединение" />
              <Toggle checked={!!draft.x11} onChange={(v) => set('x11', v)} label="X11-форвардинг" hint="Графические программы Linux; нужен X-сервер (VcXsrv, X410)" />
              <Toggle checked={draft.followTerminalFolder !== false} onChange={(v) => set('followTerminalFolder', v)} label="Открывать SFTP-панель" hint="Как в MobaXterm: файлы сервера слева от терминала" />
              <Field label="Команда при входе">
                <Select
                  value={draft.startupSnippetID ?? ''}
                  onChange={(v) => set('startupSnippetID', v || null)}
                  options={[{ value: '', label: 'Нет' }, ...snippets.map((s) => ({ value: s.id, label: s.name }))]}
                />
              </Field>
            </>
          )}
          <Field label="Заметки">
            <TextArea value={draft.notes ?? ''} onChange={(v) => set('notes', v)} placeholder="Что крутится на сервере, где лежат конфиги…" />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
