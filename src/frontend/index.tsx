/**
 * index.tsx — React entry point for MoneyPrinter Trading Terminal.
 * Mounted into <div id="root"> in public/app.html served by NestJS.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './components/Toast';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  );
}
