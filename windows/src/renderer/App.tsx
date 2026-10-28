import React, { useEffect } from 'react';
import { DEFAULT_SETTINGS } from '../shared/types';
import { activeLocation, errorText, useApp } from './state';
import { MenuHost, ToastHost, cx, toast } from './ui/kit';
import { PromptHost, TransfersPanel } from './tools';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { Home } from './components/Home';
import { TabView } from './components/Workspace';
import { StatusBar } from './components/StatusBar';
import { DialogHost } from './components/Dialogs';
import { applySettings, focusTerm } from './components/terminals';
import { closeTab, copyFromPane, openShellById, pasteToPane, startSessionBus } from './components/sessions';
import { useSaveSettings } from './components/SettingsDialog';
import { themeById } from './themes';

function useInit() {
  useEffect(() => {
    const api = window.termuxx;
    const st = useApp.getState();
    startSessionBus();
    const unsubs: (() => void)[] = [];
    api.loadData()
      .then((data) => useApp.getState().setData(data))
      .catch((err) => {
        useApp.getState().setLoadError(errorText(err));
        toast(`Не удалось загрузить данные: ${errorText(err)}`, 'error');
      });
    api.listShells().then((shells) => useApp.getState().setShells(shells)).catch(() => undefined);
    unsubs.push(api.onDataChanged((data) => useApp.getState().setData(data)));
    unsubs.push(api.onWindowState((s) => useApp.getState().setWindowState(s)));
    void st;
    return () => unsubs.forEach((u) => u());
  }, []);
}

/** Горячие клавиши (по e.code — работают и в русской раскладке). */
function useShortcuts() {
  const saveSettings = useSaveSettings();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useApp.getState();
      if (e.key === 'F11') {
        e.preventDefault();
        window.termuxx.windowControl('fullscreen');
        return;
      }
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const dialogOpen = !!st.dialog;
      const loc = activeLocation(st);
      const paneId = loc?.pane.id ?? null;
      const inTerminal = !!(document.activeElement && (document.activeElement as HTMLElement).closest('.tx-xterm'));
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      const settings = st.data?.settings ?? DEFAULT_SETTINGS;

      if (e.shiftKey) {
        switch (e.code) {
          case 'KeyP': stop(); st.setDialog(st.dialog?.type === 'palette' ? null : { type: 'palette' }); return;
          case 'KeyT': stop(); openShellById(null); return;
          case 'KeyN': stop(); st.setDialog({ type: 'server' }); return;
          case 'KeyW': if (loc && !dialogOpen) { stop(); closeTab(loc.tab.id); } return;
          case 'KeyC': if (paneId && !dialogOpen && inTerminal) { stop(); copyFromPane(paneId); } return;
          case 'KeyV': if (paneId && !dialogOpen && inTerminal) { stop(); pasteToPane(paneId); } return;
          case 'KeyF': if (paneId && !dialogOpen) { stop(); st.setSearchPane(st.searchPaneId === paneId ? null : paneId); } return;
          case 'KeyD': if (loc && !dialogOpen) { stop(); st.splitActive('row'); } return;
          case 'KeyE': if (loc && !dialogOpen) { stop(); st.splitActive('column'); } return;
          case 'KeyB': if (loc?.tab.kind === 'ssh' && !dialogOpen) { stop(); st.toggleSftp(loc.tab.id); } return;
          case 'KeyS': if (!dialogOpen) { stop(); st.setLayout({ sidebarCollapsed: !st.layout.sidebarCollapsed }); } return;
          case 'KeyM': if (st.tabs.length > 1 && !dialogOpen) { stop(); st.setMultiExec(!st.multiExec); } return;
          case 'Tab': if (st.tabs.length > 0) { stop(); cycle(-1); } return;
          default: return;
        }
      }

      if (e.key === 'Tab') {
        if (st.tabs.length > 0) { stop(); cycle(1); }
        return;
      }
      if (/^Digit[1-9]$/.test(e.code) && !dialogOpen) {
        const n = Number(e.code.slice(5));
        const target = n === 9 ? st.tabs[st.tabs.length - 1] : st.tabs[n - 1];
        if (target) { stop(); st.activateTab(target.id); }
        return;
      }
      if (e.code === 'Equal' || e.code === 'NumpadAdd') { stop(); saveSettings({ fontSize: Math.min(28, settings.fontSize + 1) }); return; }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') { stop(); saveSettings({ fontSize: Math.max(9, settings.fontSize - 1) }); return; }
      if (e.code === 'Digit0' || e.code === 'Numpad0') { stop(); saveSettings({ fontSize: DEFAULT_SETTINGS.fontSize }); return; }
      // Ctrl+K — палитра только вне терминала (в bash Ctrl+K стирает строку)
      if (e.code === 'KeyK' && !inTerminal) { stop(); st.setDialog({ type: 'palette' }); }
    };
    const cycle = (dir: 1 | -1) => {
      const st = useApp.getState();
      if (st.tabs.length === 0) return;
      const i = st.tabs.findIndex((t) => t.id === st.activeTabId);
      const next = st.tabs[(i + dir + st.tabs.length) % st.tabs.length];
      st.activateTab(next.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [saveSettings]);
}

export function App() {
  useInit();
  useShortcuts();
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const settings = useApp((s) => s.data?.settings);
  const sidebarCollapsed = useApp((s) => s.layout.sidebarCollapsed);
  const focused = useApp((s) => s.windowState.focused);
  const fullscreen = useApp((s) => s.windowState.fullscreen);
  const dialog = useApp((s) => s.dialog);
  const loaded = useApp((s) => !!s.data);
  const platform = window.termuxx.platform;

  // Настройки → все терминалы (+ цвет фона терминала для вкладок и рамок)
  useEffect(() => {
    if (!settings) return;
    applySettings(settings);
    const theme = themeById(settings.themeID);
    document.documentElement.style.setProperty('--term-bg', theme.background);
    document.documentElement.classList.toggle('tx-light-term', !!theme.light);
  }, [settings]);

  // Фон окна: Mica/Acrylic только в Windows, иначе — непрозрачный
  useEffect(() => {
    const material = platform === 'win32' && settings?.backgroundMaterial !== 'none';
    document.body.classList.toggle('no-material', !material);
    document.body.classList.toggle(`platform-${platform}`, true);
  }, [platform, settings?.backgroundMaterial]);

  // После закрытия диалога — фокус обратно в терминал
  useEffect(() => {
    if (dialog) return;
    const loc = activeLocation();
    if (loc) {
      const t = setTimeout(() => focusTerm(loc.pane.id), 40);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [dialog]);

  return (
    <div className={cx('tx-app', !focused && 'tx-unfocused', fullscreen && 'tx-fullscreen')}>
      <TitleBar />
      <div className="tx-main">
        {!sidebarCollapsed && <Sidebar />}
        <div className="tx-workspace">
          {tabs.map((tab) => <TabView key={tab.id} tab={tab} visible={tab.id === activeTabId} />)}
          {activeTabId === null && (loaded ? <Home /> : <div className="tx-loading"><div className="spinner" /></div>)}
        </div>
      </div>
      <StatusBar />
      <DialogHost />
      <TransfersPanel />
      <PromptHost />
      <MenuHost />
      <ToastHost />
    </div>
  );
}
