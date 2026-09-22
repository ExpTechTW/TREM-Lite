import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },

  // Multi-window: one HTML entry per Tauri window.
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pip: resolve(__dirname, "pip.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },

  // Tauri expects a fixed port and does not tolerate obscured errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },

  // Env vars starting with these are exposed to the client.
  envPrefix: ["VITE_", "TAURI_ENV_*"],
});
