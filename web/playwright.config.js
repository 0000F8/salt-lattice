// docs/DESIGN.md §10: the real worker (OPFS + WebCrypto + wasm) exercised
// on Chromium, WebKit and Firefox. Serial (`workers: 1`) on purpose: the
// perf spec writes one JSON file per browser under test-results/gates/ for
// `scripts/write-gates.mjs` (the globalTeardown below) to consolidate into
// docs/GATES.md, and serial execution avoids any write-ordering surprises
// in a suite this small.
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT as port, BASE_URL } from "./test-e2e/constants.js";

const webDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(webDir);

export default defineConfig({
  testDir: "./test-e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  outputDir: path.join(rootDir, "test-results"),
  globalTeardown: path.join(rootDir, "scripts", "write-gates.mjs"),
  use: {
    baseURL: BASE_URL,
  },
  webServer: {
    command: `node ${JSON.stringify(path.join(rootDir, "scripts", "serve.mjs"))} ${port}`,
    url: `${BASE_URL}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
