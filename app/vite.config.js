import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `base: './'` and a hash router let the built app be served from any path, including FastFS.
// In development the app talks to the local server (npm start) for the practice chain and the desk.
const SERVER = 'http://localhost:8791';
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(['/config.json', '/local', '/act', '/kv', '/gate'].map((path) => [path, SERVER])),
  },
});
