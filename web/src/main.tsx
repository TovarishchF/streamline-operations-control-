import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '@/app/App';
import '@/shared/i18n';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Не найден корневой элемент #root');
}

// Service worker — только в собранной версии: в режиме разработки он
// отдавал бы из кэша прежние модули вместо только что изменённых.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
