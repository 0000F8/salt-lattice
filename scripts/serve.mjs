#!/usr/bin/env node
// Tiny static file server for the Playwright suite (docs/DESIGN.md §10):
// serves `web/` at `/` and `pkg/` at `/pkg/`, with the correct
// `application/wasm` MIME type for the .wasm binary. No
// Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy headers — this
// suite needs no SharedArrayBuffer/cross-origin isolation, only OPFS +
// WebCrypto + a module Worker, none of which require them.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webDir = path.join(rootDir, "web");
const pkgDir = path.join(rootDir, "pkg");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream";
}

/** Map a request pathname to a file under webDir, or under pkgDir for `/pkg/...`. Refuses `..` traversal. */
function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("..")) return null;
  if (decoded === "/") return path.join(webDir, "index.html");
  if (decoded.startsWith("/pkg/")) {
    return path.join(pkgDir, decoded.slice("/pkg/".length));
  }
  return path.join(webDir, decoded.replace(/^\//, ""));
}

export function startServer({ port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const filePath = resolveFile(url.pathname);
      if (!filePath) {
        res.writeHead(400).end("bad path");
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.argv[2]) || 8787;
  const { url } = await startServer({ port });
  console.log(`Serving web/ (and pkg/ at /pkg) on ${url}`);
}
