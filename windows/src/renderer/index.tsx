import React from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import './components/shell.css';
import { App } from './App';

const rootEl = document.getElementById('root')!;
const root = createRoot(rootEl);

if (!window.termuxx) {
  document.body.classList.add('no-material');
  root.render(
    <div className="empty" style={{ height: '100%' }}>
      <div className="title">Termuxx не смог запуститься</div>
      <div>Не загружен мост preload (window.termuxx). Переустановите приложение.</div>
    </div>,
  );
} else {
  root.render(<App />);
  // Сообщаем main-процессу, что интерфейс отрисован (для --smoke-test и плавного показа окна)
  requestAnimationFrame(() => {
    (window as unknown as { __termuxxReady?: boolean }).__termuxxReady = true;
    window.dispatchEvent(new Event('termuxx-ready'));
  });
}
