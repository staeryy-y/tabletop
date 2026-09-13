import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

// Local dev only: `npm run dev` runs Vite's own dev server, proxying API/WS calls to
// the FastAPI backend (./run.sh --reload, http://127.0.0.1:8000) so both can hot-reload
// independently. In production there is no dev server at all — the backend serves the
// built `dist/` directly (see docs/DECISIONS.md D2), so this proxy config is inert then.
export default defineConfig({
  plugins: [preact()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/game-defs": "http://127.0.0.1:8000",
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
