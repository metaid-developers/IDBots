import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import './index.css';

if (import.meta.env.DEV) {
  window.addEventListener('error', (event) => {
    const stack = event.error instanceof Error ? event.error.stack : '';
    console.error(
      `[window.error] ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}${stack ? `\n${stack}` : ''}`
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error
      ? `${event.reason.message}\n${event.reason.stack ?? ''}`.trim()
      : String(event.reason);
    console.error(`[unhandledrejection] ${reason}`);
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

try {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </React.StrictMode>
  );
} catch (error) {
  console.error('Failed to render the app:', error);
}
