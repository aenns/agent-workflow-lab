import { defineConfig } from 'vite';
import { workerControl } from './worker-control.mjs';

const server = {
  host: '127.0.0.1',
  strictPort: true,
  proxy: {
    '/java/api': {
      target: process.env.JAVA_API_PROXY_TARGET || 'http://127.0.0.1:8083',
      rewrite: (path) => path.replace(/^\/java/, ''),
    },
    '/python/api': {
      target: process.env.PY_API_PROXY_TARGET || 'http://127.0.0.1:8082',
      rewrite: (path) => path.replace(/^\/python/, ''),
    },
    '/typescript/api': {
      target: process.env.TS_API_PROXY_TARGET || 'http://127.0.0.1:8081',
      rewrite: (path) => path.replace(/^\/typescript/, ''),
    },
    '/api': {
      target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8080',
    },
  },
};

export default defineConfig({
  plugins: [workerControl()],
  server: { ...server, port: 5173 },
  preview: { ...server, port: 4173 },
});
