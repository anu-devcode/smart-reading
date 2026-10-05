import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web UI lives in /web. In dev, /api is proxied to the local Node server.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../web-dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:4177" },
  },
});
