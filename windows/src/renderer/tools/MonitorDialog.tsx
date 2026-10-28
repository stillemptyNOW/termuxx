// Полный дашборд сервера: CPU, память, сеть, диски, процессы, сервисы systemd и Docker.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDown, ArrowUp, Box, Cpu, HardDrive, ListFilter, MemoryStick, Network, Play, RefreshCw,
  RotateCw, ScrollText, Search, Server as ServerIcon, Square,
} from 'lucide-react';
import type { ContainerInfo, MonitorSnapshot, Server, ServiceInfo } from '../../shared/types';
import { Dialog, IconButton, Segmented, Spinner, cx, formatBytes, formatDuration, plural, toast } from '../ui/kit';
import { AreaChart, Meter, Ring } from './charts';
import { ConfirmDialog, LogDialog } from './dialogs';
import { useMonitor } from './stores';
import { api, collator, errorText, formatRate, levelColor } from './util';

export interface MonitorDialogProps {
  sessionId: string;
  server: Server;
  onClose: () => void;
}

type ServiceFilter = 'failed' | 'running' | 'all';
type Target = { kind: 'service' | 'container'; name: string };
type Action = 'restart' | 'start' | 'stop' | 'logs';

const ACTION_TEXT: Record<Exclude<Action, 'logs'>, { verb: string; done: string }> = {
  restart: { verb: 'Перезапустить', done: 'Перезапущено' },
  start: { verb: 'Запустить', done: 'Запущено' },
  stop: { verb: 'Остановить', done: 'Остановлено' },
};

export function MonitorDialog({ sessionId, server, onClose }: MonitorDialogProps) {
  const entry = useMonitor(sessionId);
  const snap = entry?.snapshot ?? null;
  const history = entry?.history ?? [];

  const [services, setServices] = useState<ServiceInfo[] | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<ServiceFilter>('running');
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState<(Target & { action: Exclude<Action, 'logs'> }) | null>(null);
  const [log, setLog] = useState<(Target & { text: string; loading: boolean }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refreshLists = useCallback(async () => {
    setRefreshing(true);
    const [s, c] = await Promise.allSettled([api().listServices(sessionId), api().listContainers(sessionId)]);
    if (s.status === 'fulfilled') { setServices(s.value); setServicesError(null); } else setServicesError(errorText(s.reason));
    setContainers(c.status === 'fulfilled' ? c.value : []);
    setRefreshing(false);
  }, [sessionId]);

  useEffect(() => {
    void refreshLists();
    const id = window.setInterval(() => void refreshLists(), 30000);
    return () => window.clearInterval(id);
  }, [refreshLists]);

  const failedCount = services?.filter((s) => s.active === 'failed').length ?? 0;
  const runningCount = services?.filter((s) => s.sub === 'running').length ?? 0;

  // Если есть упавшие сервисы — показать их сразу.
  useEffect(() => {
    if (failedCount > 0) setFilter((f) => (f === 'running' ? 'failed' : f));
  }, [failedCount]);

  const shownServices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (services ?? [])
      .filter((s) => filter === 'all' || (filter === 'failed' ? s.active === 'failed' : s.sub === 'running'))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .sort((a, b) => collator.compare(a.name, b.name));
  }, [services, filter, search]);

  const loadLogs = useCallback(async (t: Target) => {
    setLog({ ...t, text: '', loading: true });
    try {
      const fn = t.kind === 'service' ? api().serviceAction : api().containerAction;
      const text = await fn(sessionId, t.name, 'logs');
      setLog({ ...t, text, loading: false });
    } catch (err) {
      setLog({ ...t, text: `Не удалось получить логи: ${errorText(err)}`, loading: false });
    }
  }, [sessionId]);

  const run = useCallback(async (t: Target, action: Exclude<Action, 'logs'>) => {
    const key = `${t.kind}:${t.name}`;
    setBusy(key);
    try {
      const fn = t.kind === 'service' ? api().serviceAction : api().containerAction;
      const out = await fn(sessionId, t.name, action);
      toast(`${ACTION_TEXT[action].done}: ${t.name}`, 'success');
      if (out && /(fail|error|denied|не удалось|ошибка|password)/i.test(out)) toast(out.trim().slice(0, 300), 'error');
      void refreshLists();
    } catch (err) {
      toast(`${ACTION_TEXT[action].verb} не удалось: ${errorText(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [sessionId, refreshLists]);

  const actions = (t: Target, active: boolean) => {
    const key = `${t.kind}:${t.name}`;
    if (busy === key) return <span className="tx-row-actions"><Spinner size={14} /></span>;
    return (
      <span className="tx-row-actions">
        <IconButton title="Перезапустить" onClick={() => setConfirm({ ...t, action: 'restart' })}><RotateCw size={14} /></IconButton>
        {active
          ? <IconButton title="Остановить" onClick={() => setConfirm({ ...t, action: 'stop' })}><Square size={13} /></IconButton>
          : <IconButton title="Запустить" onClick={() => setConfirm({ ...t, action: 'start' })}><Play size={14} /></IconButton>}
        <IconButton title="Логи" onClick={() => void loadLogs(t)}><ScrollText size={14} /></IconButton>
      </span>
    );
  };

  const title = (
    <span className="row" style={{ gap: 10 }}>
      Мониторинг
      <span className="faint" style={{ fontWeight: 400 }}>{server.name || server.hostname}</span>
      {entry?.error && snap && <span className="badge" title={entry.error}>нет связи</span>}
    </span>
  );

  return (
    <Dialog
      title={title}
      icon={<Activity size={18} className="tx-accent" />}
      size="full"
      onClose={() => { if (!confirm && !log) onClose(); }}
    >
      {!snap ? (
        <div className="tx-center" style={{ minHeight: 320 }}>
          {entry?.error
            ? <><span className="tx-error-text">{entry.error}</span><span className="faint">Повторная попытка через несколько секунд…</span></>
            : <><Spinner size={22} /><span className="muted">Собираю данные о сервере…</span></>}
        </div>
      ) : (
        <div className="tx-dash">
          <div className="tx-dash-hero">
            <div className="tx-dash-host">
              <ServerIcon size={20} className="tx-accent" />
              <span className="tx-dash-hostname">{snap.hostname}</span>
            </div>
            <div className="tx-dash-sub">
              {snap.os} · ядро {snap.kernel} · аптайм {formatDuration(snap.uptime)} · LA {snap.load.map((l) => l.toFixed(2)).join(' ')}
            </div>
          </div>

          <div className="tx-dash-grid">
            {/* CPU */}
            <section className="tx-card">
              <header><Cpu size={15} /> Процессор <span className="faint">· {snap.cores} {plural(snap.cores, 'ядро', 'ядра', 'ядер')}</span></header>
              <div className="tx-big" style={{ color: levelColor(snap.cpu / 100) }}>{Math.round(snap.cpu)}%</div>
              <AreaChart series={[{ values: history.map((p) => p.cpu), color: '#3DDC97' }]} max={100} capacity={60} />
              <div className="tx-card-foot">Нагрузка {snap.load[0].toFixed(2)} · {snap.load[1].toFixed(2)} · {snap.load[2].toFixed(2)}</div>
            </section>

            {/* Память */}
            <section className="tx-card">
              <header><MemoryStick size={15} /> Память</header>
              <MemoryBody snap={snap} />
            </section>

            {/* Сеть */}
            <section className="tx-card">
              <header><Network size={15} /> Сеть</header>
              <div className="tx-net-rates">
                <span><ArrowDown size={16} className="tx-rx" /> {formatRate(snap.netRx)}</span>
                <span><ArrowUp size={16} className="tx-tx" /> {formatRate(snap.netTx)}</span>
              </div>
              <AreaChart
                series={[
                  { values: history.map((p) => p.rx), color: '#3DDC97' },
                  { values: history.map((p) => p.tx), color: '#4EA8FF' },
                ]}
                capacity={60}
              />
              <div className="tx-card-foot">
                Пик за период: ↓ {formatRate(Math.max(0, ...history.map((p) => p.rx)))} · ↑ {formatRate(Math.max(0, ...history.map((p) => p.tx)))}
              </div>
            </section>

            {/* Диски */}
            <section className="tx-card tx-span-2">
              <header><HardDrive size={15} /> Диски</header>
              <div className="tx-disks">
                {snap.disks.length === 0 && <div className="faint">Нет данных о дисках</div>}
                {snap.disks.map((d) => {
                  const f = d.size > 0 ? d.used / d.size : 0;
                  return (
                    <div key={d.mount} className="tx-disk">
                      <div className="row">
                        <span className="mono ellipsis grow">{d.mount}</span>
                        <span className="faint">{formatBytes(d.used)} из {formatBytes(d.size)}</span>
                        <span className="tx-disk-pct" style={{ color: levelColor(f) }}>{Math.round(f * 100)}%</span>
                      </div>
                      <Meter value={f} />
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Процессы */}
            <section className="tx-card">
              <header><Activity size={15} /> Процессы <span className="faint">· по CPU</span></header>
              <table className="tx-table">
                <thead><tr><th>PID</th><th>Процесс</th><th className="num">CPU</th><th className="num">RAM</th></tr></thead>
                <tbody>
                  {snap.processes.slice(0, 8).map((p) => (
                    <tr key={p.pid}>
                      <td className="mono faint">{p.pid}</td>
                      <td className="ellipsis mono" style={{ maxWidth: 160 }}>{p.name}</td>
                      <td className="num" style={{ color: levelColor(p.cpu / 100) }}>{p.cpu.toFixed(1)}%</td>
                      <td className="num faint">{p.mem.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {/* Сервисы */}
          <section className="tx-card">
            <header>
              <ListFilter size={15} /> Сервисы systemd
              <span className="grow" />
              <Segmented<ServiceFilter>
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'failed', label: <>Ошибки{failedCount > 0 && <span className="tx-count err">{failedCount}</span>}</> },
                  { value: 'running', label: <>Работают<span className="tx-count">{runningCount}</span></> },
                  { value: 'all', label: <>Все<span className="tx-count">{services?.length ?? 0}</span></> },
                ]}
              />
              <span className="tx-search">
                <Search size={13} />
                <input placeholder="Поиск" value={search} onChange={(e) => setSearch(e.target.value)} spellCheck={false} />
              </span>
              <IconButton title="Обновить" onClick={() => void refreshLists()}>
                {refreshing ? <Spinner size={13} /> : <RefreshCw size={14} />}
              </IconButton>
            </header>
            {servicesError && <div className="tx-error-text" style={{ padding: '8px 0' }}>{servicesError}</div>}
            {services === null && !servicesError && <div className="row muted" style={{ padding: 10 }}><Spinner size={13} /> Загружаю список сервисов…</div>}
            {services !== null && shownServices.length === 0 && (
              <div className="faint" style={{ padding: 12 }}>
                {filter === 'failed' ? 'Упавших сервисов нет 🎉' : 'Ничего не найдено'}
              </div>
            )}
            <div className="tx-svc-list">
              {shownServices.slice(0, 300).map((s) => {
                const state = s.active === 'failed' ? 'err' : s.sub === 'running' ? 'ok' : s.active === 'active' ? 'warn' : 'off';
                return (
                  <div key={s.name} className="tx-svc">
                    <span className={cx('dot', state)} />
                    <span className="mono tx-svc-name ellipsis" title={s.name}>{s.name.replace(/\.service$/, '')}</span>
                    <span className="muted ellipsis grow" title={s.description}>{s.description}</span>
                    <span className={cx('badge', state === 'ok' && 'accent')}>{s.active === 'failed' ? 'ошибка' : s.sub}</span>
                    {actions({ kind: 'service', name: s.name }, s.active === 'active')}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Docker */}
          {containers && containers.length > 0 && (
            <section className="tx-card">
              <header><Box size={15} /> Docker <span className="faint">· {containers.filter((c) => c.running).length} из {containers.length} запущено</span></header>
              <div className="tx-svc-list">
                {containers.map((c) => (
                  <div key={c.name} className="tx-svc">
                    <span className={cx('dot', c.running ? 'ok' : 'off')} />
                    <span className="mono tx-svc-name ellipsis" title={c.name}>{c.name}</span>
                    <span className="faint mono ellipsis" style={{ width: 200 }} title={c.image}>{c.image}</span>
                    <span className="muted ellipsis grow">{c.status}</span>
                    {actions({ kind: 'container', name: c.name }, c.running)}
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="tx-dash-foot faint">
            Обновляется каждые 3 секунды · {new Date(snap.time || Date.now()).toLocaleTimeString('ru-RU')}
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={`${ACTION_TEXT[confirm.action].verb} ${confirm.kind === 'service' ? 'сервис' : 'контейнер'}?`}
          message={<><span className="mono">{confirm.name}</span> на сервере {server.name || server.hostname}.</>}
          confirmText={ACTION_TEXT[confirm.action].verb}
          danger={confirm.action === 'stop'}
          onClose={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); void run(c, c.action); }}
        >
          {confirm.action !== 'start' && /ssh|sshd/.test(confirm.name) && (
            <div className="tx-warn-box">Осторожно: это SSH-сервер. Остановка или неудачный перезапуск может отключить вас от сервера.</div>
          )}
        </ConfirmDialog>
      )}
      {log && (
        <LogDialog
          title={`Логи · ${log.name}`}
          text={log.text}
          loading={log.loading}
          onClose={() => setLog(null)}
          onRefresh={() => void loadLogs(log)}
        />
      )}
    </Dialog>
  );
}

function MemoryBody({ snap }: { snap: MonitorSnapshot }) {
  const used = Math.max(0, snap.memTotal - snap.memAvailable);
  const f = snap.memTotal > 0 ? used / snap.memTotal : 0;
  const swapUsed = Math.max(0, snap.swapTotal - snap.swapFree);
  const sf = snap.swapTotal > 0 ? swapUsed / snap.swapTotal : 0;
  return (
    <div className="tx-mem">
      <Ring value={f}>
        <span className="tx-ring-pct">{Math.round(f * 100)}%</span>
        <span className="faint">ОЗУ</span>
      </Ring>
      <div className="col grow" style={{ gap: 6 }}>
        <div><span className="tx-mem-num">{formatBytes(used)}</span> <span className="faint">из {formatBytes(snap.memTotal)}</span></div>
        <div className="faint">Доступно {formatBytes(snap.memAvailable)}</div>
        <div style={{ marginTop: 6 }}>
          {snap.swapTotal > 0
            ? <>
                <div className="row"><span className="muted grow">Swap</span><span className="faint">{formatBytes(swapUsed)} из {formatBytes(snap.swapTotal)}</span></div>
                <Meter value={sf} thin />
              </>
            : <span className="faint">Swap выключен</span>}
        </div>
      </div>
    </div>
  );
}
