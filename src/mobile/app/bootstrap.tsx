import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/index.css';
import './twin-ui.css';
import MobileApp from './MobileApp';
import { initSystemThemeListener, loadSettings } from './services/settings';

/**
 * Hydrates persisted language + theme from the R-store before first paint
 * (no flash of the wrong theme), then mounts the shell. The OS theme
 * listener keeps 'system' mode in sync afterward.
 */
export async function mountMobileApp(): Promise<void> {
  await loadSettings();
  initSystemThemeListener();
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Failed to find the root element');
  }
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>,
  );
}
