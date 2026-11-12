// A fetch stand-in that serves URLs from local folders, like a static host with CORS.
// Options mark origins whose files lack CORS headers or that cannot be reached.
import { readFile } from "node:fs/promises";
import path from "node:path";

export function fileFetch(mounts, { noCors = [], unreachable = [], log = [] } = {}) {
  return async (url, init = {}) => {
    const href = String(url);
    const origin = new URL(href).origin;
    log.push({ url: href, init });
    if (unreachable.includes(origin)) throw new TypeError("Failed to fetch");
    if (noCors.includes(origin)) {
      if (init.mode === "no-cors") return { ok: false, status: 0, type: "opaque", url: href, headers: new Map(), text: async () => "" };
      throw new TypeError("Failed to fetch");
    }
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (!href.startsWith(prefix)) continue;
      let rel = decodeURIComponent(href.slice(prefix.length).split(/[?#]/)[0]).replace(/^\//, "");
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      try {
        const body = await readFile(path.join(dir, rel), "utf8");
        const type = rel.endsWith(".json") ? "application/json" : rel.endsWith(".html") ? "text/html" : "text/plain";
        return { ok: true, status: 200, url: href, headers: new Map([["content-type", type]]), text: async () => body };
      } catch {
        return { ok: false, status: 404, url: href, headers: new Map(), text: async () => "Not found" };
      }
    }
    return { ok: false, status: 404, url: href, headers: new Map(), text: async () => "Not found" };
  };
}
