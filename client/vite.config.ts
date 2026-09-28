import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Forward API calls to the server package during development.
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
