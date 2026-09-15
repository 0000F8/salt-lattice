// Shared between web/playwright.config.js and the e2e fixture/specs, so the
// port lives in exactly one place.
export const PORT = 8787;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
