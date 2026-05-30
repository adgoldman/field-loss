import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite dev server on :5173. /api/* is proxied to the Express server on :8787,
// so the React app can call /api/... same-origin (no CORS, no localhost quirks).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
