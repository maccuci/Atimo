import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const { version } = createRequire(import.meta.url)("./package.json") as {
  version: string;
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },

  // The 500 kB warning is a network heuristic. Tauri embeds the bundle in the
  // binary and loads it from disk, so a big chunk costs parse time, not a
  // download. Mermaid already loads lazily in its own chunk (~1.5 MB).
  build: { chunkSizeWarningLimit: 2000 },

  // Read from one place. A version typed into the source as well as into
  // `package.json` is a version that is wrong in a crash report exactly when it
  // matters — after a release nobody remembered to bump twice.
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
