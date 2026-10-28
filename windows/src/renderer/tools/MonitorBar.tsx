// Строка удалённого мониторинга в статус-баре (как в MobaXterm): CPU, память, диск, сеть, аптайм.
import React from 'react';
import { Activity, ArrowDown, ArrowUp, Clock, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import { Spinner, cx, formatBytes, formatDuration } from '../ui/kit';
import { Meter } from './charts';
import { useMonitor } from './stores';
import { formatRate, levelColor } from './util';

export interface MonitorBarProps {
  sessionId: string;
  onOpenDashboard: () => void;
}

export function MonitorBar({ sessionId, onOpenDashboard }: MonitorBarProps) {
  const entry = useMonitor(sessionId);
  const snap = entry?.snapshot ?? null;

  if (!snap) {
    return (
      <button className="tx-monbar" onClick={onOpenDashboard} title={entry?.error ?? 'Сбор данных о сервере…'}>
        {entry?.error
          ? <span className="faint"><Activity size={13} /> Мониторинг недоступен</span>
          : <span className="faint row" style={{ gap: 6 }}><Spinner size={11} /> Мониторинг…</span>}
      </button>
    );
  }

  const cpu = snap.cpu / 100;
  const memUsed = Math.max(0, snap.memTotal - snap.memAvailable);
  const mem = snap.memTotal > 0 ? memUsed / snap.memTotal : 0;
  const root = snap.disks.find((d) => d.mount === '/') ?? snap.disks[0];
  const disk = root && root.size > 0 ? root.used / root.size : 0;
  const stale = entry?.error != null;

  return (
    <button
      className={cx('tx-monbar', stale && 'stale')}
      onClick={onOpenDashboard}
      title={`${snap.hostname} — открыть мониторинг${stale ? `\nПоследняя ошибка: ${entry?.error}` : ''}`}
    >
      <span className="tx-monbar-item" title={`Процессор: ${Math.round(snap.cpu)}% · ядер: ${snap.cores}`}>
        <Cpu size={13} style={{ color: levelColor(cpu) }} />
        <span className="tx-monbar-val">{Math.round(snap.cpu)}%</span>
        <span className="tx-monbar-meter"><Meter value={cpu} thin /></span>
      </span>
      <span className="tx-monbar-item" title={`Память: ${formatBytes(memUsed)} из ${formatBytes(snap.memTotal)}`}>
        <MemoryStick size={13} style={{ color: levelColor(mem) }} />
        <span className="tx-monbar-val">{formatBytes(memUsed)} / {formatBytes(snap.memTotal)}</span>
        <span className="tx-monbar-meter"><Meter value={mem} thin /></span>
      </span>
      {root && (
        <span className="tx-monbar-item" title={`Диск ${root.mount}: ${formatBytes(root.used)} из ${formatBytes(root.size)}`}>
          <HardDrive size={13} style={{ color: levelColor(disk) }} />
          <span className="tx-monbar-val">{root.mount} {Math.round(disk * 100)}%</span>
        </span>
      )}
      <span className="tx-monbar-item tx-monbar-net" title="Сеть: приём / передача">
        <ArrowDown size={12} className="tx-rx" />
        <span className="tx-monbar-val">{formatRate(snap.netRx)}</span>
        <ArrowUp size={12} className="tx-tx" />
        <span className="tx-monbar-val">{formatRate(snap.netTx)}</span>
      </span>
      <span className="tx-monbar-item tx-monbar-wide" title={`Аптайм · нагрузка ${snap.load.map((l) => l.toFixed(2)).join(' ')}`}>
        <Clock size={12} className="faint" />
        <span className="tx-monbar-val">{formatDuration(snap.uptime)}</span>
        <span className="faint">LA {snap.load[0].toFixed(2)}</span>
      </span>
    </button>
  );
}
