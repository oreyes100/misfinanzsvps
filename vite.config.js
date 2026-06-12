import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // En desarrollo, la API serverless vive en producción (Vercel).
    proxy: {
      "/api": {
        target: "https://mis-finazas-gold.vercel.app",
        changeOrigin: true,
      },
    },
  },
});
