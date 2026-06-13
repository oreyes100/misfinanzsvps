import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Permite consumir la API Express existente sin problemas de CORS
    proxy: { '/api': 'http://localhost:3002' },
  },
});
