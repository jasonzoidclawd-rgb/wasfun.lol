import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const overlayRoot = path.dirname(fileURLToPath(import.meta.url));

function productionDevAliases() {
  const modules = [
    ["tierFixture", "tierFixture"],
    ["fixtureMode", "fixtureMode"],
    ["useAramggTierFixture", "useAramggTierFixture"],
    ["DevOverlayDiagnostics", "DevOverlayDiagnostics"],
    ["DevOverlayDiagnostics.css", "empty.css"],
  ];

  return modules.flatMap(([name, replacementName]) => {
    const replacement = path.resolve(overlayRoot, "src/dev/production", replacementName);
    // Rollup sees the app's relative imports before Vite has normalized them
    // to absolute paths, so register both forms explicitly.
    return [
      { find: `./dev/${name}`, replacement },
      { find: path.resolve(overlayRoot, "src/dev", name), replacement },
    ];
  });
}

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [react()],

  // Production must not contain fixture data, ARAMGG adapters, or diagnostic
  // controls. Replace the dev modules at bundle time; Vite dev keeps the real
  // modules so the fixture workflow remains unchanged.
  resolve: {
    alias: command === "build" ? productionDevAliases() : [],
  },

  // Expose MAYHEM_-prefixed env (e.g. MAYHEM_OVERLAY_TIER_FIXTURE) to the
  // client in addition to the default VITE_ prefix. Only read under a DEV guard.
  envPrefix: ["VITE_", "MAYHEM_"],

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
      : { overlay: false },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // DEV-ONLY: proxy the tier-fixture's ARAMGG requests server-side so the
    // Tauri webview fetches a same-origin path (satisfying `connect-src 'self'`
    // in tauri.conf.json) instead of a cross-origin URL that CORS would block.
    // This block exists ONLY on the Vite dev server — `tauri build` produces a
    // static bundle with no proxy, so production CSP/networking is untouched.
    proxy: {
      "/aramgg-dev": {
        target: "https://aramgg.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/aramgg-dev/, ""),
      },
    },
  },
}));
