import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './polyfills';
import { initSecretStore } from './lib/secretStore';

// API keys must be loaded (and migrated out of localStorage) before any
// component reads them.
initSecretStore().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
