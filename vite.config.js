/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "node",
    include: ["src/**/*.test.{js,jsx}"],
  },
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
