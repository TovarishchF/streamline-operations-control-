import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Слежение опросом: dev-сервер работает в контейнере, а исходники
    // подмонтированы с хоста. Через bind mount на Windows и macOS события
    // файловой системы до контейнера не доходят, и Vite продолжает отдавать
    // прежний файл — правка в редакторе просто не появляется в браузере.
    // Интервал секунда: чаще незачем, реже — заметно на глаз.
    watch: { usePolling: true, interval: 1000 },
    proxy: {
      // Префикс со слешем на конце: '/api' перехватывал бы и клиентский
      // маршрут /api-docs, который должен обслуживаться приложением.
      '/api/': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api/': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
