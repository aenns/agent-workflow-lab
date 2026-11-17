import { defineConfig } from 'vite';

const server = {
  host: '127.0.0.1',
  strictPort: true,
  proxy: {
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
  server: { ...server, port: 5173 },
  preview: { ...server, port: 4173 },
});
