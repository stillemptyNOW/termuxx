// Реестр xterm.js-терминалов: живут дольше React-компонентов (переключение вкладок не теряет историю).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { Settings } from '../../shared/types';
import { fontStack, themeById, xtermTheme } from '../themes';

export interface TermHooks {
  onData(paneId: string, data: string): void;
  onResize(paneId: string, cols: number, rows: number): void;
  onTitle(paneId: string, title: string): void;
  onBell(paneId: string): void;
  onSelection(paneId: string, text: string): void;
  onOpened(paneId: string): void;
}

export interface TermEntry {
  paneId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  opened: boolean;
  opening: boolean;
  webgl: WebglAddon | null;
  disposed: boolean;
}

const registry = new Map<string, TermEntry>();
let hooks: TermHooks | null = null;
let currentSettings: Settings | null = null;

export function setTermHooks(h: TermHooks) {
  hooks = h;
}

export function getTerm(paneId: string): TermEntry | undefined {
  return registry.get(paneId);
}

export function allTerms(): TermEntry[] {
  return [...registry.values()];
}

function optionsFor(s: Settings) {
  return {
    fontFamily: fontStack(s.fontFamily),
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    theme: xtermTheme(themeById(s.themeID)),
  } as const;
}

export function ensureTerm(paneId: string, settings: Settings): TermEntry {
  const existing = registry.get(paneId);
  if (existing) return existing;
  currentSettings = settings;
  const term = new Terminal({
    ...optionsFor(settings),
    allowProposedApi: true,
    allowTransparency: false,
    convertEol: false,
    drawBoldTextInBrightColors: true,
    fontWeightBold: 'bold',
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    smoothScrollDuration: 0,
    scrollOnUserInput: true,
    cursorInactiveStyle: 'outline',
    minimumContrastRatio: 1,
    wordSeparator: ' ()[]{}\'"`,;|',
  });
  const fit = new FitAddon();
  const search = new SearchAddon({ highlightLimit: 2000 });
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((event, uri) => {
    // как в Windows Terminal: ссылка открывается по Ctrl+клику (или обычному клику, если зажат Ctrl недоступен)
    if (event.ctrlKey || event.metaKey || event.button === 1) window.termuxx.openExternal(uri);
  }));
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch {
    /* без Unicode 11 тоже работает */
  }

  const el = document.createElement('div');
  el.className = 'tx-xterm';
  const entry: TermEntry = { paneId, term, fit, search, el, opened: false, opening: false, webgl: null, disposed: false };

  term.onData((data) => hooks?.onData(paneId, data));
  term.onResize(({ cols, rows }) => hooks?.onResize(paneId, cols, rows));
  term.onTitleChange((title) => hooks?.onTitle(paneId, title));
  term.onBell(() => hooks?.onBell(paneId));
  term.onSelectionChange(() => {
    if (term.hasSelection()) hooks?.onSelection(paneId, term.getSelection());
  });

  registry.set(paneId, entry);
  return entry;
}

function visible(el: HTMLElement): boolean {
  return el.isConnected && el.offsetWidth > 0 && el.offsetHeight > 0;
}

async function waitFonts(s: Settings | null) {
  if (!s) return;
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`${s.fontSize}px "${s.fontFamily}"`),
        document.fonts.load(`bold ${s.fontSize}px "${s.fontFamily}"`),
      ]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    /* шрифт не найден — xterm возьмёт запасной */
  }
}

function loadWebgl(entry: TermEntry) {
  if (entry.webgl) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      try { webgl.dispose(); } catch { /* уже освобождён */ }
      entry.webgl = null;
    });
    entry.term.loadAddon(webgl);
    entry.webgl = webgl;
  } catch {
    entry.webgl = null; // нет WebGL — работает DOM-рендерер
  }
}

/** Вставить терминал в контейнер и открыть, когда он станет видимым. */
export function attachTerm(entry: TermEntry, host: HTMLElement) {
  if (entry.el.parentElement !== host) host.appendChild(entry.el);
  tryOpen(entry);
}

export function tryOpen(entry: TermEntry) {
  if (entry.opened || entry.opening || entry.disposed) return;
  if (!visible(entry.el)) return;
  entry.opening = true;
  void waitFonts(currentSettings).then(() => {
    entry.opening = false;
    if (entry.opened || entry.disposed || !visible(entry.el)) return;
    entry.term.open(entry.el);
    entry.opened = true;
    loadWebgl(entry);
    try { entry.fit.fit(); } catch { /* размер ещё не известен */ }
    hooks?.onOpened(entry.paneId);
  });
}

const pendingFit = new Set<string>();
let fitFrame = 0;

/** Подогнать размер (с объединением запросов в один кадр). */
export function scheduleFit(paneId: string) {
  pendingFit.add(paneId);
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    const ids = [...pendingFit];
    pendingFit.clear();
    for (const id of ids) {
      const entry = registry.get(id);
      if (!entry || entry.disposed) continue;
      if (!entry.opened) {
        tryOpen(entry);
        continue;
      }
      if (!visible(entry.el)) continue;
      try { entry.fit.fit(); } catch { /* скрыт */ }
    }
  });
}

export function focusTerm(paneId: string) {
  const entry = registry.get(paneId);
  if (entry?.opened) entry.term.focus();
}

export function disposeTerm(paneId: string) {
  const entry = registry.get(paneId);
  if (!entry) return;
  entry.disposed = true;
  registry.delete(paneId);
  try { entry.term.dispose(); } catch { /* уже */ }
  entry.el.remove();
}

/** Применить настройки ко всем открытым терминалам (тема, шрифт и т.д.). */
export function applySettings(s: Settings) {
  const prev = currentSettings;
  currentSettings = s;
  const fontChanged = !prev || prev.fontFamily !== s.fontFamily || prev.fontSize !== s.fontSize || prev.lineHeight !== s.lineHeight;
  const opts = optionsFor(s);
  const apply = () => {
    for (const entry of registry.values()) {
      if (entry.disposed) continue;
      const t = entry.term;
      t.options.theme = opts.theme;
      t.options.cursorStyle = opts.cursorStyle;
      t.options.cursorBlink = opts.cursorBlink;
      t.options.scrollback = opts.scrollback;
      if (fontChanged) {
        t.options.fontFamily = opts.fontFamily;
        t.options.fontSize = opts.fontSize;
        t.options.lineHeight = opts.lineHeight;
        if (entry.webgl) {
          try { entry.webgl.clearTextureAtlas(); } catch { /* ок */ }
        }
      }
      if (entry.opened && visible(entry.el)) {
        try { entry.fit.fit(); } catch { /* ок */ }
      }
    }
  };
  if (fontChanged) void waitFonts(s).then(apply);
  else apply();
}

export function termSize(paneId: string): { cols: number; rows: number } {
  const entry = registry.get(paneId);
  if (entry?.opened) return { cols: entry.term.cols, rows: entry.term.rows };
  return { cols: 120, rows: 32 };
}
