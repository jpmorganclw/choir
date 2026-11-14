import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { loadConfig } from './api.js';
import App from './App.jsx';
import { SessionProvider } from './session.jsx';
import './styles.css';

const root = createRoot(document.getElementById('root'));

loadConfig()
  .then(() => {
    root.render(
      <StrictMode>
        <HashRouter>
          <SessionProvider>
            <App />
          </SessionProvider>
        </HashRouter>
      </StrictMode>,
    );
  })
  .catch((error) => {
    root.render(
      <div style={{ maxWidth: 560, margin: '80px auto', padding: 24, fontFamily: 'system-ui' }}>
        <h2>Choir could not start</h2>
        <p>The app reads its settings from config.json next to this page, and that did not load.</p>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{String(error?.message ?? error)}</pre>
      </div>,
    );
  });
