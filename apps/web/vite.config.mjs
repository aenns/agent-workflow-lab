import { defineConfig } from 'vite';

const server = {
  host: '127.0.0.1',
  strictPort: true,
  proxy: {
    '/api': {
      target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8080',
    },
  },
};

export default defineConfig({
  server: { ...server, port: 5173 },
  preview: { ...server, port: 4173 },
});
