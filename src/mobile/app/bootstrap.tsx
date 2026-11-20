import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/index.css';
import './twin-ui.css';
import MobileApp from './MobileApp';
import { initSystemThemeListener, loadSettings } from './services/settings';

/**
 * Mounts the shell immediately while persisted language + theme hydrate from
 * the R-store in the background. The OS theme listener keeps 'system' mode in
 * sync afterward, so a disconnected settings read cannot hold the launch splash.
 */
export async function mountMobileApp(): Promise<void> {
  try {
    void loadSettings();
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
  } finally {
    requestAnimationFrame(() => document.getElementById('idbots-launch-splash')?.remove());
  }
}
