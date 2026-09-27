import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// The web shell reuses the shared @trem/core frontend, but ships ONLY the main
// window (no Tauri pip/settings windows) and runs in a real browser tab. Native
// features (Rust audio/config/ntp) are absent here — core already degrades via
// its `inTauri` guards (window.fetch, DEFAULT_CONFIG, …); a proper platform
// layer will make the web fallbacks first-class.
const coreRoot = resolve(__dirname, "../../packages/core");

export default defineConfig({
  root: coreRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(coreRoot, "src") },
  },
  // GitHub Pages project site is served under /<repo>/. Override via base if you
  // later use a custom domain or user/organization page.
  base: "/TREM-Lite/",
  // Files the web serves as they are (packages/core/static): the sound effects,
  // which the desktop embeds in its binary instead, and the intensity model,
  // which the desktop downloads from here. Only this build copies them — the
  // desktop frontend would otherwise carry 15 MB it never loads.
  publicDir: resolve(coreRoot, "static"),
  build: {
    target: "es2022",
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    // Web is single-window: only the main entry, not pip/settings.
    rollupOptions: { input: resolve(coreRoot, "index.html") },
  },
  server: { port: 5173 },
  envPrefix: ["VITE_"],
});
