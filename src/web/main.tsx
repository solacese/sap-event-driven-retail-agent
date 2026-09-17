// ---------------------------------------------------------------------------
// React root. Loads the Solace brand stylesheet and mounts <App/>.
// ---------------------------------------------------------------------------
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted webfonts (bundled via Vite, served under font-src 'self' - no
// external CDN, no CSP change, works offline). Inter is a humanist grotesque
// close in spirit to SAP's proprietary "72" face; JetBrains Mono for topics/JSON.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@bible-strong/avatar-react/styles.css';
import './styles/brand.css';
import { App } from './App.js';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
