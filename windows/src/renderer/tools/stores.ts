// Общие хранилища инструментов: мониторинг (с подсчётом ссылок) и передачи файлов.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { MonitorSnapshot, TransferProgress } from '../../shared/types';
import { api } from './util';

// ======================================================================
// Мониторинг
// ======================================================================

export interface MonitorPoint {
  t: number;
  cpu: number;
  mem: number; // 0–100
  rx: number;
  tx: number;
}

export interface MonitorEntry {
  snapshot: MonitorSnapshot | null;
  history: MonitorPoint[];
  error: string | null;
  updatedAt: number;
}

const HISTORY = 120; // ~6 минут при опросе раз в 3 с
const POLL_MS = 3000;

interface MonitorStore {
  bySession: Record<string, MonitorEntry>;
  apply: (sessionId: string, snapshot: MonitorSnapshot | null, error?: string) => void;
  drop: (sessionId: string) => void;
}

export const useMonitorStore = create<MonitorStore>((set) => ({
  bySession: {},
  apply: (sessionId, snapshot, error) => set((s) => {
    const prev = s.bySession[sessionId] ?? { snapshot: null, history: [], error: null, updatedAt: 0 };
    if (!snapshot) {
      return { bySession: { ...s.bySession, [sessionId]: { ...prev, error: error ?? 'Нет данных', updatedAt: Date.now() } } };
    }
    const mem = snapshot.memTotal > 0 ? ((snapshot.memTotal - snapshot.memAvailable) / snapshot.memTotal) * 100 : 0;
    const point: MonitorPoint = { t: snapshot.time || Date.now(), cpu: snapshot.cpu, mem, rx: snapshot.netRx, tx: snapshot.netTx };
    const history = [...prev.history, point].slice(-HISTORY);
    return { bySession: { ...s.bySession, [sessionId]: { snapshot, history, error: null, updatedAt: Date.now() } } };
  }),
  drop: (sessionId) => set((s) => {
    const next = { ...s.bySession };
    delete next[sessionId];
    return { bySession: next };
  }),
}));

const refCounts = new Map<string, number>();
let monitorUnsub: (() => void) | null = null;

function ensureMonitorSubscription() {
  if (monitorUnsub) return;
  monitorUnsub = api().onMonitor((e) => {
    // Обновляем только сессии, на которые кто-то подписан.
    if (!refCounts.has(e.sessionId)) return;
    useMonitorStore.getState().apply(e.sessionId, e.snapshot, e.error);
  });
}

/** Подписаться на мониторинг сессии. Возвращает функцию отписки. Опрос общий для бара и дашборда. */
export function acquireMonitor(sessionId: string): () => void {
  ensureMonitorSubscription();
  const n = refCounts.get(sessionId) ?? 0;
  refCounts.set(sessionId, n + 1);
  if (n === 0) api().monitorStart(sessionId, POLL_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = refCounts.get(sessionId) ?? 0;
    if (cur <= 1) {
      refCounts.delete(sessionId);
      api().monitorStop(sessionId);
    } else {
      refCounts.set(sessionId, cur - 1);
    }
  };
}

/** Хук: данные мониторинга сессии (пока компонент смонтирован — идёт опрос). */
export function useMonitor(sessionId: string, enabled = true): MonitorEntry | undefined {
  useEffect(() => {
    if (!enabled || !sessionId) return;
    return acquireMonitor(sessionId);
  }, [sessionId, enabled]);
  return useMonitorStore((s) => s.bySession[sessionId]);
}

// ======================================================================
// Передачи файлов
// ======================================================================

export interface TransferItem extends TransferProgress {
  startedAt: number;
  updatedAt: number;
  localPath?: string;
  dismissed?: boolean;
}

interface TransferStore {
  items: Record<string, TransferItem>;
  order: string[];
  upsert: (p: TransferProgress) => void;
  dismiss: (id: string) => void;
  clearFinished: () => void;
}

export const useTransferStore = create<TransferStore>((set) => ({
  items: {},
  order: [],
  upsert: (p) => set((s) => {
    const prev = s.items[p.transferId];
    const now = Date.now();
    const extra = p as TransferProgress & { localPath?: string };
    const item: TransferItem = {
      ...p,
      startedAt: prev?.startedAt ?? now,
      updatedAt: now,
      localPath: extra.localPath ?? prev?.localPath,
      dismissed: prev?.dismissed && p.state !== 'running' ? prev.dismissed : false,
    };
    const order = prev ? s.order : [p.transferId, ...s.order].slice(0, 50);
    return { items: { ...s.items, [p.transferId]: item }, order };
  }),
  dismiss: (id) => set((s) => {
    const item = s.items[id];
    if (!item) return s;
    return { items: { ...s.items, [id]: { ...item, dismissed: true } } };
  }),
  clearFinished: () => set((s) => {
    const items: Record<string, TransferItem> = {};
    const order: string[] = [];
    for (const id of s.order) {
      const it = s.items[id];
      if (it && it.state === 'running') {
        items[id] = it;
        order.push(id);
      }
    }
    return { items, order };
  }),
}));

type TransferListener = (p: TransferProgress) => void;
const transferListeners = new Set<TransferListener>();
let transferUnsub: (() => void) | null = null;

/** Единая подписка на api.onTransfer (идемпотентно). */
export function ensureTransferSubscription(): void {
  if (transferUnsub) return;
  transferUnsub = api().onTransfer((p) => {
    useTransferStore.getState().upsert(p);
    transferListeners.forEach((l) => {
      try { l(p); } catch { /* слушатель не должен ронять остальных */ }
    });
  });
}

/** Подписка компонентов на события передач (например, обновить список после загрузки). */
export function onTransferEvent(listener: TransferListener): () => void {
  ensureTransferSubscription();
  transferListeners.add(listener);
  return () => { transferListeners.delete(listener); };
}

/** Запомнить, куда скачивается передача (если main не сообщает localPath). */
export function noteTransferTarget(transferId: string, localPath: string | undefined): void {
  if (!localPath) return;
  const s = useTransferStore.getState();
  const it = s.items[transferId];
  if (it) {
    useTransferStore.setState({ items: { ...s.items, [transferId]: { ...it, localPath: it.localPath ?? localPath } } });
  }
}
