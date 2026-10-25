import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Build-stamp the service worker cache: public/sw.js contains __BUILD_ID__;
// replacing it with the build timestamp means every deploy ships a new
// CACHE_NAME and `activate` evicts the old one, so no user is pinned to a
// previous bundle. The stamp follows `--outDir`: a hardcoded dist/ left other
// outputs unstamped and rewrote an unrelated dist/sw.js.
function buildStampServiceWorker() {
  let outDir = "dist";
  return {
    name: "build-stamp-sw",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const path = resolve(outDir, "sw.js");
      const stamp = Date.now().toString(36);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll("__BUILD_ID__", stamp));
    },
  };
}

export default defineConfig({
  plugins: [react(), buildStampServiceWorker()],
  build: {
    rollupOptions: {
      output: {
        // #41: keep the map engine in its own long-lived vendor chunk so
        // deploys re-download only the app code, and Fleet's lazy surface
        // stays small. PDF tooling already loads on demand (ReportActions).
        manualChunks(id) {
          // R2 (/driver ≤ 250 KB gzip of JS): Rollup's CommonJS interop
          // helpers (used by react, react-dom) otherwise land in the maplibre
          // chunk, so the entry imported them from it and index.html
          // modulepreloaded all of maplibre (~283 KB gzip) plus its CSS on
          // every route, /driver included. A tiny helper chunk keeps the map
          // engine lazy.
          if (id.includes("commonjsHelpers")) return "cjs-helpers";
          if (id.includes("node_modules/maplibre-gl")) return "maplibre";
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    // gsc P0-1: scripts/phone-demo.* serves this preview through a free HTTPS
    // tunnel. Only those tunnel domains are accepted (localhost and IPs always
    // are); PYTHIA_TUNNEL_HOSTS adds more, comma-separated (e.g. ".ngrok-free.app").
    // The phone calls /api on the same origin through the proxy below, so the
    // backend needs no CORS entry for the tunnel URL.
    allowedHosts: [
      ".trycloudflare.com",
      ".loca.lt",
      ...(process.env.PYTHIA_TUNNEL_HOSTS || "")
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean),
    ],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8001",
        changeOrigin: true,
      },
    },
  },
});
