// Preloaded into a server child (NODE_OPTIONS=--require <this file>) so that
// no test ever reaches the network. Replaces global fetch:
//   api.figma.com/v1/...  -> a canned response from FETCH_STUB_ROUTES
//   registry.npmjs.org    -> 404 (the update check is also off)
//   anything else         -> the real fetch (the proxy talks to 127.0.0.1)
// FETCH_STUB_ROUTES is JSON: { "GET /me": { status: 200, body: {...} }, ... }
// keyed by "METHOD /v1-relative-path-with-query". An unknown route answers 404
// with a body naming it, so a missing fixture shows up in the golden.
// FETCH_STUB_LOG (optional file) receives one JSON line per api.figma.com
// request: { method, path, headers, body }.
const fs = require("fs");
const realFetch = globalThis.fetch;
const routes = JSON.parse(process.env.FETCH_STUB_ROUTES || "{}");
const logFile = process.env.FETCH_STUB_LOG || "";

function reply(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body === undefined ? {} : body);
  return new Response(text, { status, statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : status === 403 ? "Forbidden" : "Stub", headers: { "content-type": "application/json" } });
}

globalThis.fetch = async function stubbedFetch(input, init) {
  const url = new URL(typeof input === "string" ? input : input.url || String(input));
  if (url.hostname === "api.figma.com") {
    const method = ((init && init.method) || "GET").toUpperCase();
    const p = url.pathname.replace(/^\/v1/, "") + url.search;
    if (logFile) {
      try {
        fs.appendFileSync(logFile, JSON.stringify({ method, path: p, headers: (init && init.headers) || {}, body: init && init.body !== undefined ? init.body : null }) + "\n");
      } catch (e) {}
    }
    const hit = routes[method + " " + p];
    if (!hit) return reply(404, { status: 404, err: "stub: no route for " + method + " " + p });
    return reply(hit.status || 200, hit.body);
  }
  if (url.hostname === "registry.npmjs.org") return reply(404, { error: "stub: registry is off" });
  return realFetch(input, init);
};
