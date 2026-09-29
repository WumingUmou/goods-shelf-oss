import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import type { Plugin } from "vite";

// One id per build: baked into the JS (__BUILD_ID__) and published as /version.json.
// A running app polls version.json; a mismatch means the server has a newer build.
const BUILD_ID = new Date().toISOString();
const versionFile = (): Plugin => ({
  name: "version-file",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) });
  },
});

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    versionFile(),
    react(),
    tailwindcss(),
    VitePWA({
      // registered by hand in main.tsx (only on HTTPS; plain-http LAN access has no service worker)
      injectRegister: false,
      registerType: "autoUpdate",
      // manifest, icons, title and theme colours are per instance (设置 → 外观) and served by the backend
      manifest: false,
      workbox: {
        // hashed build assets are precached; the HTML shell is NOT (network-first below) so a
        // new deploy is picked up on the next page load without forcing a reload mid-edit
        globPatterns: ["**/*.{js,css}"],
        navigateFallback: null,
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: { cacheName: "pages", networkTimeoutSeconds: 4 },
          },
          {
            // instance artwork: URLs carry ?v=<upload time>
            urlPattern: ({ url }) => url.pathname.startsWith("/brand/") || url.pathname.startsWith("/icons/"),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "brand" },
          },
          {
            // content-addressed (sha256) → never changes
            urlPattern: ({ url }) => url.pathname.startsWith("/media/"),
            handler: "CacheFirst",
            options: { cacheName: "media", expiration: { maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 60 } },
          },
          {
            // self-hosted font slices: versioned names, fetched on demand → keep once used (offline titles)
            urlPattern: ({ url }) => url.pathname.startsWith("/fonts/") && url.pathname.endsWith(".woff2"),
            handler: "CacheFirst",
            options: { cacheName: "fonts", expiration: { maxEntries: 200 } },
          },
          { urlPattern: ({ url }) => url.pathname.startsWith("/api/"), handler: "NetworkOnly" },
        ],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      output: {
        // framework code rarely changes → its own long-cached chunk; app code changes every deploy
        codeSplitting: {
          groups: [{ name: "vendor", test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@tanstack)[\\/]/ }],
        },
      },
    },
  },
  server: {
    port: 5173,
    // everything the backend serves (API, images, per-instance appearance)
    proxy: Object.fromEntries(
      ["/api", "/media", "/brand", "/icons", "/manifest.webmanifest"].map((p) => [p, "http://localhost:8090"]),
    ),
  },
});
