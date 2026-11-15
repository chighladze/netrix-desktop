import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;

          const normalized = id.replace(/\\/g, "/");

          // IMPORTANT: do NOT split react / react-dom / scheduler / jsx-runtime
          // into a separate chunk. Some third-party libraries do
          // `import React from "react"` and then `React.useState(...)`. When
          // React lives in a different chunk than its consumers, Rollup's
          // production output can fail the default-export interop across the
          // chunk boundary, leaving `React` undefined at runtime and crashing
          // the whole app with "Cannot read properties of undefined (reading
          // 'useState')". Keep React in the default vendor chunk with its
          // consumers.

          if (normalized.includes("/@tauri-apps/")) {
            return "tauri";
          }
          if (normalized.includes("/react-icons/")) {
            return "icons";
          }
          if (normalized.includes("/@xterm/")) {
            return "terminal";
          }

          return "vendor";
        },
      },
    },
  },
  esbuild: {
    drop: mode === "production" ? ["console", "debugger"] : [],
  },
}));
