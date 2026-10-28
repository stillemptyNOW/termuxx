// Плавающая панель передач файлов (скачивания и загрузки SFTP).
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, ChevronDown, ChevronUp, FolderOpen, X, XCircle } from 'lucide-react';
import { IconButton, Progress, cx, formatBytes, plural } from '../ui/kit';
import { ensureTransferSubscription, useTransferStore, type TransferItem } from './stores';
import { api, formatEta, formatRate } from './util';

const IDLE_COLLAPSE_MS = 6000;   // свернуть через 6 с после окончания всех передач
const IDLE_HIDE_MS = 45000;      // спрятать завершённые через 45 с

export function TransfersPanel() {
  useEffect(() => { ensureTransferSubscription(); }, []);
  const items = useTransferStore((s) => s.items);
  const order = useTransferStore((s) => s.order);
  const dismiss = useTransferStore((s) => s.dismiss);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(Date.now());

  const list = useMemo(
    () => order
      .map((id) => items[id])
      .filter((t): t is TransferItem => !!t && !t.dismissed)
      .sort((a, b) => {
        const ra = a.state === 'running' ? 0 : 1;
        const rb = b.state === 'running' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return ra === 0 ? a.startedAt - b.startedAt : b.updatedAt - a.updatedAt;
      }),
    [order, items],
  );
  const running = list.filter((t) => t.state === 'running');
  const lastUpdate = list.reduce((m, t) => Math.max(m, t.updatedAt), 0);

  // Часы для автосворачивания.
  useEffect(() => {
    if (list.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [list.length]);

  // Новая передача — развернуть.
  useEffect(() => {
    if (running.length > 0) setExpanded(true);
  }, [running.length]);

  const idleFor = running.length === 0 ? now - lastUpdate : 0;
  useEffect(() => {
    if (running.length === 0 && idleFor > IDLE_COLLAPSE_MS && expanded) setExpanded(false);
  }, [idleFor, running.length, expanded]);

  if (list.length === 0) return null;
  if (running.length === 0 && idleFor > IDLE_HIDE_MS && !expanded) return null;

  const totalDone = running.reduce((n, t) => n + t.done, 0);
  const totalAll = running.reduce((n, t) => n + t.total, 0);
  const speed = running.reduce((n, t) => n + t.speed, 0);
  const failed = list.filter((t) => t.state === 'error').length;

  const summary = running.length > 0
    ? `${running.length} ${plural(running.length, 'передача', 'передачи', 'передач')} · ${formatRate(speed)}`
    : failed > 0
      ? `Готово, ошибок: ${failed}`
      : 'Все передачи завершены';

  return (
    <div className={cx('tx-transfers glass', !expanded && 'collapsed')}>
      <div className="tx-transfers-head" onClick={() => setExpanded(!expanded)}>
        {running.length > 0
          ? <span className="tx-pulse" />
          : failed > 0 ? <XCircle size={15} color="var(--danger)" /> : <CheckCircle2 size={15} color="var(--accent)" />}
        <span className="grow ellipsis">{summary}</span>
        {running.length > 0 && totalAll > 0 && <span className="faint">{Math.floor((totalDone / totalAll) * 100)}%</span>}
        {running.length === 0 && (
          <IconButton title="Очистить список" onClick={(e) => { e.stopPropagation(); clearFinished(); }}><X size={14} /></IconButton>
        )}
        <IconButton title={expanded ? 'Свернуть' : 'Развернуть'}>{expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</IconButton>
      </div>
      {!expanded && running.length > 0 && totalAll > 0 && <Progress value={totalDone / totalAll} />}
      {expanded && (
        <div className="tx-transfers-list">
          {list.slice(0, 12).map((t) => <TransferRow key={t.transferId} t={t} onDismiss={() => dismiss(t.transferId)} />)}
        </div>
      )}
    </div>
  );
}

function TransferRow({ t, onDismiss }: { t: TransferItem; onDismiss: () => void }) {
  const fraction = t.total > 0 ? t.done / t.total : 0;
  const eta = t.speed > 0 && t.total > 0 ? (t.total - t.done) / t.speed : 0;
  const Icon = t.direction === 'download' ? ArrowDownToLine : ArrowUpFromLine;
  const files = t.files > 1 ? ` · файл ${Math.min(t.filesDone + 1, t.files)} из ${t.files}` : '';

  let detail: React.ReactNode;
  switch (t.state) {
    case 'running':
      detail = (
        <>
          {formatBytes(t.done)}{t.total > 0 ? ` из ${formatBytes(t.total)}` : ''} · {formatRate(t.speed)}
          {eta > 0 ? ` · осталось ${formatEta(eta)}` : ''}{files}
        </>
      );
      break;
    case 'done':
      detail = <span className="tx-accent">{t.direction === 'download' ? 'Скачано' : 'Загружено'} · {formatBytes(t.total || t.done)}{t.files > 1 ? ` · ${t.files} ${plural(t.files, 'файл', 'файла', 'файлов')}` : ''}</span>;
      break;
    case 'cancelled':
      detail = <span className="faint">Отменено</span>;
      break;
    default:
      detail = <span className="tx-error-text">{t.error || 'Ошибка передачи'}</span>;
  }

  return (
    <div className={cx('tx-transfer', t.state)}>
      <div className={cx('tx-transfer-icon', t.direction)}><Icon size={15} /></div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="tx-transfer-name ellipsis" title={t.name}>{t.name || '…'}</div>
        <div className="tx-transfer-detail ellipsis">{detail}</div>
        {t.state === 'running' && <Progress value={fraction} />}
      </div>
      <div className="tx-transfer-actions">
        {t.state === 'running' && (
          <IconButton title="Отменить" onClick={() => api().cancelTransfer(t.transferId)}><X size={14} /></IconButton>
        )}
        {t.state === 'done' && t.direction === 'download' && t.localPath && (
          <IconButton title="Показать в папке" onClick={() => api().showItemInFolder(t.localPath!)}><FolderOpen size={14} /></IconButton>
        )}
        {t.state !== 'running' && (
          <IconButton title="Убрать из списка" onClick={onDismiss}><X size={14} /></IconButton>
        )}
      </div>
    </div>
  );
}
