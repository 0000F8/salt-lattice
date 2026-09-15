// Shared Playwright fixture for the e2e suite (docs/DESIGN.md §10).
//
// WebKit's OPFS backing store needs a real on-disk profile:
// `navigator.storage.getDirectory()` throws a generic `UnknownError` under
// WebKit's default ephemeral browser context, even though Chromium and
// Firefox are fine with one (confirmed while diagnosing this — see the
// debug scripts this was worked out with, no longer in the repo). Launching
// a *fresh* persistent context per test made Chromium's context teardown
// flaky (occasional 30s+ hangs) under this suite's back-to-back runs, so
// instead every project gets ONE context for the whole worker (one real
// browser launch, persistent only for WebKit), reused by every test via a
// fresh `page`. Test isolation is then explicit: every spec calls
// `resetLatticeStorage(page)` at the top of each test instead of relying on
// a fresh context per test.
import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE_URL } from "./constants.js";

export const test = base.extend({
  // A separate name from the built-in `context` fixture: Playwright fixes
  // that fixture's scope at "test", so a worker-scoped replacement has to
  // live under its own name instead of an override.
  sharedContext: [
    async ({ playwright, browserName }, use) => {
      if (browserName === "webkit") {
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-webkit-"));
        const context = await playwright.webkit.launchPersistentContext(userDataDir, {
          baseURL: BASE_URL,
        });
        await use(context);
        await context.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
        return;
      }
      const browser = await playwright[browserName].launch();
      const context = await browser.newContext({ baseURL: BASE_URL });
      await use(context);
      await context.close();
      await browser.close();
    },
    { scope: "worker" },
  ],
  page: async ({ sharedContext }, use) => {
    const page = await sharedContext.newPage();
    await use(page);
    await page.close();
  },
});

export { expect };

/**
 * Wipe this origin's `lattice-keys` IndexedDB database and the OPFS
 * `lattice/` directory. Call at the top of every test: contexts (and their
 * on-disk storage, for WebKit) are reused across tests in the same file for
 * speed, so this is what gives each test a clean slate instead of a fresh
 * context per test.
 */
export async function resetLatticeStorage(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase("lattice-keys");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("lattice", { recursive: true });
    } catch {
      // Nothing to remove yet — fine.
    }
  });
}
