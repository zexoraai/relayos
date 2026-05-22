import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'path';

export default defineConfig({
  plugins: [preact()],
  base: '/new/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Proxy API calls to the Express server during dev so we don't need CORS gymnastics
    proxy: {
      '/auth': 'http://localhost:3001',
      '/onboarding': 'http://localhost:3001',
      '/pipeline': 'http://localhost:3001',
      '/fulfillment': 'http://localhost:3001',
      '/customers': 'http://localhost:3001',
      '/caretaker': 'http://localhost:3001',
      '/whatsapp': 'http://localhost:3001',
      '/knowledge': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/dlq': 'http://localhost:3001',
      '/idempotency': 'http://localhost:3001',
      '/settings': 'http://localhost:3001',
      '/reference': 'http://localhost:3001',
    },
  },
});
