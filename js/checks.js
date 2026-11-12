// checks.js — Preflight's conformance checks for an open agentic website.
//
// It reads a site's public agent files the way another site's browser would: from a
// different origin, with no credentials, through ordinary CORS. It then checks them
// against the Worldwide Agentic Web MVP specification (profile 0.2) and parses and
// validates each network with the reference browser runtime's own code, so a pass here
// means the reference runtime accepts the network too.
//
// No model is involved. The same input always gives the same report. The module runs in
// the browser and in Node (tests pass a fetch stub).

import { parseHocon } from "../runtime/hocon.js";
import { AgentNetwork, validateNetwork } from "../runtime/kernel.js";
import { find_front_man, classify_tool } from "../runtime/generated/graph.gen.mjs";

export const PROFILE = {
  name: "Worldwide Agentic Web MVP",
  version: "0.2",
  date: "6 November 2026",
  url: "https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md",
};

// Section anchors in the published spec, for links in the report.
export const SECTIONS = {
  "2.1": { title: "Minimum network content", anchor: "21-minimum-network-content" },
  "2.2": { title: "Portable data profile", anchor: "22-portable-data-profile" },
  "3.1": { title: "Minimum runtime behavior", anchor: "31-minimum-runtime-behavior" },
  "3.2": { title: "Loading a peer agent site", anchor: "32-protocol-for-loading-a-peer-agent-site" },
  "3.3": { title: "Minimum public files", anchor: "33-minimum-public-files" },
  "3.4": { title: "Browser origin requirements", anchor: "34-browser-origin-requirements" },
  "4": { title: "Pluggable inference", anchor: "4-tenet-three-pluggable-inference" },
  "5": { title: "Security and privacy", anchor: "5-cross-cutting-security-and-privacy-requirements" },
  "6": { title: "MVP interoperability checks", anchor: "6-mvp-interoperability-checks" },
  "challenge": { title: "Open Agentic Web Challenge checklist", anchor: "" },
};

export function sectionUrl(section) {
  const entry = SECTIONS[section];
  if (!entry || !entry.anchor) return PROFILE.url;
  return `${PROFILE.url}#${entry.anchor}`;
}

// Check groups, in the order the report shows them.
export const GROUPS = [
  { id: "files", title: "Public files" },
  { id: "network", title: "Network definition" },
  { id: "peers", title: "Peers, tools and private context" },
  { id: "inference", title: "Inference and credentials" },
  { id: "portability", title: "Loading as a peer" },
  { id: "discovery", title: "Optional discovery files" },
  { id: "challenge", title: "Challenge submission checklist" },
];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_BYTES = 2_000_000;

// --- Target parsing ------------------------------------------------------------------

/**
 * Work out where a site's manifest should be, from what the visitor typed.
 *
 * Spec 3.2 step 1: a peer-network URL's final path component is the network name and
 * the path before it is the site base. A visitor may also paste the site's home page,
 * the manifest itself, or a network file, so each form gives one or two candidates to
 * try in order.
 *
 * :param input: The text the visitor entered.
 * :return: {ok, url, candidates: [{base, network, how}]} or {ok: false, reason}.
 */
export function parseTarget(input) {
  const text = String(input || "").trim();
  if (!text) return { ok: false, reason: "Enter the URL of an agentic website." };
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: "That is not a complete URL." };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, reason: "Only http and https URLs can host an agentic website." };
  }
  url.hash = "";
  const path = url.pathname;
  const dir = path.replace(/[^/]*$/, "");
  const last = path.split("/").pop();
  const root = `${url.origin}${dir}`.replace(/\/$/, "");
  const candidates = [];
  if (/\/agent-manifest\.json$/i.test(path)) {
    candidates.push({ base: root, network: null, how: "manifest URL" });
  } else if (/\.json$/i.test(path) || /\.hocon$/i.test(path)) {
    candidates.push({ base: root, network: null, networkFile: url.href, how: "network file URL" });
  } else if (path.endsWith("/") || !last) {
    candidates.push({ base: `${url.origin}${path}`.replace(/\/$/, ""), network: null, how: "site URL" });
  } else if (/\.html?$/i.test(last)) {
    candidates.push({ base: root, network: null, how: "page URL" });
  } else {
    // "https://host/agents/name": spec form first (base + network), then the whole
    // path as a site base, for a site URL typed without its trailing slash.
    candidates.push({ base: root, network: decodeURIComponent(last), how: "peer-network URL" });
    candidates.push({ base: `${url.origin}${path}`.replace(/\/$/, ""), network: null, how: "site URL" });
  }
  return { ok: true, url: url.href, candidates };
}

export function isLoopback(url) {
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
}

export function originOf(url) {
  try { return new URL(url).origin; } catch { return ""; }
}

// --- Fetching public files -----------------------------------------------------------

/**
 * Fetch one public file the way a peer site's browser would.
 *
 * Spec 3.4: public artifact requests must not include the caller's credentials, so the
 * request omits cookies. When the browser blocks the response, a second no-cors request
 * tells a missing CORS header (the server answered) apart from an unreachable host.
 *
 * :param url: The absolute URL.
 * :param fetchImpl: fetch, or a stub in tests.
 * :return: A file record: url, finalUrl, ok, status, text, bytes, contentType, ms,
 *   corsBlocked, unreachable, error.
 */
export async function fetchPublic(url, fetchImpl) {
  const started = Date.now();
  const record = {
    url, finalUrl: url, ok: false, status: 0, text: "", bytes: 0, contentType: "",
    ms: 0, corsBlocked: false, unreachable: false, error: "",
  };
  let response;
  try {
    response = await fetchImpl(url, { credentials: "omit", cache: "no-store", redirect: "follow" });
  } catch (error) {
    record.ms = Date.now() - started;
    record.error = String(error?.message || error);
    try {
      await fetchImpl(url, { mode: "no-cors", credentials: "omit", cache: "no-store" });
      record.corsBlocked = true;
    } catch {
      record.unreachable = true;
    }
    return record;
  }
  record.status = response.status;
  record.finalUrl = response.url || url;
  record.contentType = response.headers?.get?.("content-type") || "";
  try {
    record.text = await response.text();
  } catch (error) {
    record.error = String(error?.message || error);
  }
  record.bytes = record.text.length;
  record.ms = Date.now() - started;
  record.ok = response.ok && !record.error;
  if (record.bytes > MAX_BYTES) {
    record.ok = false;
    record.error = `The file is ${record.bytes.toLocaleString()} characters, more than Preflight reads (${MAX_BYTES.toLocaleString()}).`;
  }
  return record;
}

// --- Small helpers -------------------------------------------------------------------

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveAgainst(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(String(path).replace(/^\.\//, ""), `${base}/`).href;
}

/** Visit every value in a JSON document once, with its key and path. */
function walk(value, visit, path = "$", key = null) {
  visit({ key, value, path });
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${path}[${index}]`, null));
  } else if (isObject(value)) {
    for (const [childKey, item] of Object.entries(value)) walk(item, visit, `${path}.${childKey}`, childKey);
  }
}

/** Show only enough of a secret to find it: the first four characters and the length. */
export function maskSecret(value) {
  const text = String(value);
  return `${text.slice(0, 4)}… (${text.length} characters)`;
}

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

// --- Credential scan (spec 4) ---------------------------------------------------------

const SECRET_KEY = /^(api[_-]?key|apikey|x-api-key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|client[_-]?secret|secret|password|passwd|private[_-]?key|token)$/i;
const PLACEHOLDER = /^(<[^>]*>|\$\{[^}]*\}|\{[^}]*\}|x+|\*+|\.\.\.|todo|tbd|none|null|changeme|your[-_ ]?(api[-_ ]?)?key( here)?)$/i;
const SECRET_PATTERNS = [
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI-style secret key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "AWS access key ID", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Key in a URL", re: /[?&](api[_-]?key|key|token|access_token|auth)=[^&\s"']{8,}/i },
];

/**
 * Find credentials in a published file.
 *
 * :param doc: The parsed JSON document.
 * :param file: The file's URL, for the report.
 * :return: Findings: {file, path, kind, masked}.
 */
export function findSecrets(doc, file) {
  const findings = [];
  walk(doc, ({ key, value, path }) => {
    if (typeof value !== "string") return;
    if (key !== null && SECRET_KEY.test(key)) {
      const trimmed = value.trim();
      if (trimmed.length >= 8 && !PLACEHOLDER.test(trimmed)) {
        findings.push({ file, path, kind: `value of "${key}"`, masked: maskSecret(trimmed) });
      }
      return;
    }
    {
      for (const pattern of SECRET_PATTERNS) {
        const match = value.match(pattern.re);
        if (match) {
          findings.push({ file, path, kind: pattern.name, masked: maskSecret(match[0]) });
          break;
        }
      }
    }
  });
  return findings;
}

// --- JSON Schema shape (spec 2.1 invocation schemas) ----------------------------------

const SCHEMA_TYPES = new Set(["object", "string", "number", "integer", "boolean", "array", "null"]);

/**
 * Check that an agent's function.parameters is a usable JSON Schema object.
 *
 * :param schema: The parameters value.
 * :return: A list of problems, empty when the schema is usable.
 */
export function schemaProblems(schema) {
  const problems = [];
  if (!isObject(schema)) return ["parameters is not an object"];
  if (schema.type !== "object") problems.push(`type is ${JSON.stringify(schema.type)}, not "object"`);
  if (schema.properties !== undefined && !isObject(schema.properties)) {
    problems.push("properties is not an object");
  }
  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const [name, property] of Object.entries(properties)) {
    if (!isObject(property)) {
      problems.push(`property "${name}" is not a schema object`);
      continue;
    }
    const types = Array.isArray(property.type) ? property.type : [property.type];
    if (property.type !== undefined && !types.every((type) => SCHEMA_TYPES.has(type))) {
      problems.push(`property "${name}" has unknown type ${JSON.stringify(property.type)}`);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === "string")) {
      problems.push("required is not a list of property names");
    } else {
      for (const name of schema.required) {
        if (!(name in properties)) problems.push(`required lists "${name}", which is not in properties`);
      }
    }
  }
  return problems;
}

// --- Private-context rules (spec 2.1, 5) ---------------------------------------------

function slyFields(value) {
  if (value === true || value === "*") return ["*"];
  if (Array.isArray(value)) return value.map(String);
  if (isObject(value)) {
    return Object.entries(value).filter(([, keep]) => keep !== false).map(([name]) => name);
  }
  return [];
}

/**
 * List each agent's private-context (sly_data) allow rules.
 *
 * :param config: The network configuration.
 * :return: Rules: {agent, direction, fields}.
 */
export function slyRules(config) {
  const rules = [];
  for (const agent of config.tools || []) {
    const allow = agent?.allow;
    if (!isObject(allow)) continue;
    for (const direction of ["to_downstream", "from_downstream", "to_upstream", "from_upstream"]) {
      if (allow[direction] && allow[direction].sly_data !== undefined) {
        rules.push({ agent: agent.name, direction, fields: slyFields(allow[direction].sly_data) });
      }
    }
  }
  return rules;
}

// --- The report ----------------------------------------------------------------------

class Report {
  constructor(input) {
    this.target = input;
    this.base = "";
    this.requestedNetwork = null;
    this.interpretation = "";
    this.profile = PROFILE;
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.files = [];
    this.checks = [];
    this.networks = [];
    this.declined = [];
  }

  add(check) {
    this.checks.push({ network: null, evidence: [], fix: "", detail: "", ...check });
  }

  addFile(record, role) {
    const { text, ...rest } = record;
    this.files.push({ ...rest, role });
  }

  summarize() {
    const count = (level, status) => this.checks.filter((c) => c.level === level && c.status === status).length;
    const fails = (ids) => this.checks.some((c) => ids.some((id) => c.id.startsWith(id)) && c.status === "fail");
    const warns = (ids) => this.checks.some((c) => ids.some((id) => c.id.startsWith(id)) && c.status === "warn");
    const fetched = (role) => this.files.some((f) => f.role === role && f.ok);
    const blocked = this.files.some((f) => ["manifest", "network"].includes(f.role) && f.corsBlocked);
    const mustFailed = count("must", "fail");
    const verdicts = {
      publishes: {
        label: "Publishes a valid network",
        ok: fetched("manifest") && fetched("network") && !fails(["manifest.", "network.", "agent.", "refs."]),
      },
      crossOrigin: {
        label: "Readable from other origins",
        ok: fetched("manifest") && fetched("network") && !blocked,
      },
      portable: {
        label: "Runs when another site loads it",
        ok: fetched("network") && !fails(["network.data_only", "agent.coded", "portable."]) && !warns(["portable."]),
      },
      credentials: {
        label: "No credentials in public files",
        ok: fetched("manifest") && !fails(["secrets."]),
      },
    };
    this.summary = {
      must: { pass: count("must", "pass"), fail: mustFailed },
      should: { pass: count("should", "pass"), warn: count("should", "warn") + count("should", "fail") },
      info: this.checks.filter((c) => c.level === "info").length,
      verdicts,
      ready: Object.values(verdicts).every((v) => v.ok) && mustFailed === 0,
    };
    this.finishedAt = new Date().toISOString();
    return this;
  }
}

// --- Running the checks --------------------------------------------------------------

/**
 * Check one agentic website.
 *
 * :param input: The URL the visitor entered.
 * :param options: {fetch, approve(origin, purpose) -> Promise<boolean>, approved: Set of
 *   origins already approved, deep: also check each linked peer's manifest}.
 * :return: The report (see Report).
 */
export async function runPreflight(input, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const approved = options.approved || new Set();
  const approve = options.approve || (async () => true);
  const report = new Report(input);

  const target = parseTarget(input);
  if (!target.ok) {
    report.add({ id: "target.url", group: "files", section: "3.2", level: "must", status: "fail", title: "Site URL", detail: target.reason });
    return report.summarize();
  }

  const mayContact = async (url, purpose) => {
    const origin = originOf(url);
    if (approved.has(origin)) return true;
    const ok = await approve(origin, purpose);
    if (ok) approved.add(origin);
    else report.declined.push(origin);
    return ok;
  };

  // 1. Find the manifest.
  let manifestRecord = null;
  let chosen = null;
  for (const candidate of target.candidates) {
    const url = `${candidate.base}/agent-manifest.json`;
    if (!(await mayContact(url, "read its public agent-manifest.json"))) {
      report.add({ id: "target.consent", group: "files", section: "5", level: "info", status: "skip", title: "Contact declined", detail: `You declined to contact ${originOf(url)}, so nothing was read.` });
      return report.summarize();
    }
    const record = await fetchPublic(url, fetchImpl);
    manifestRecord = record;
    chosen = candidate;
    if (record.ok || record.corsBlocked) break;
  }
  report.base = chosen.base;
  report.requestedNetwork = chosen.network;
  report.interpretation = chosen.how;
  report.addFile(manifestRecord, "manifest");

  checkHttps(report, chosen.base);
  const manifest = checkManifestFetch(report, manifestRecord);
  if (!manifest) {
    await checkChallenge(report, chosen.base, null, fetchImpl);
    return report.summarize();
  }

  // 2. Manifest content.
  const entries = checkManifestContent(report, manifest, chosen);
  checkSecrets(report, manifest, manifestRecord.url);

  // 3. links.json (publisher-owned peer bindings).
  const linksUrl = `${chosen.base}/links.json`;
  const linksRecord = await fetchPublic(linksUrl, fetchImpl);
  report.addFile(linksRecord, "links");
  let links = null;
  if (linksRecord.ok) {
    try { links = JSON.parse(linksRecord.text); } catch { links = undefined; }
    if (links) checkSecrets(report, links, linksUrl);
  }

  // 4. Each network definition.
  for (const entry of entries) {
    await checkNetwork(report, { entry, manifest, base: chosen.base, links, linksRecord, fetchImpl, mayContact, deep: !!options.deep });
  }
  checkLinksFile(report, links, linksRecord, entries);

  // 5. Optional discovery files and the challenge checklist.
  await checkDiscovery(report, chosen.base, fetchImpl);
  await checkChallenge(report, chosen.base, manifest, fetchImpl);
  return report.summarize();
}

function checkHttps(report, base) {
  const https = base.startsWith("https://");
  const local = isLoopback(base);
  report.add({
    id: "files.https", group: "files", section: "3.3", level: "must",
    status: https || local ? "pass" : "fail",
    title: "Served over HTTPS",
    detail: https
      ? "The site base uses HTTPS."
      : local
        ? "Loopback HTTP is fine while you develop. Publish over HTTPS."
        : "Production agent sites must use HTTPS. Visitors' keys and peer loads depend on it.",
    evidence: [base],
    fix: https || local ? "" : "Serve the site and its agent files over HTTPS.",
  });
}

function describeFetchFailure(record) {
  if (record.corsBlocked) {
    return {
      detail: "The server answered, but the browser blocked Preflight from reading the response: it has no Access-Control-Allow-Origin header that allows other sites. The browser also hides the status code, so the file may be missing as well.",
      fix: "Serve the public agent files (agent-manifest.json, the network file, links.json) with the header Access-Control-Allow-Origin: *. GitHub Pages does this already; on Netlify use a _headers file, on Apache a .htaccess rule.",
    };
  }
  if (record.unreachable) {
    return {
      detail: `The host could not be reached (${record.error || "network error"}).`,
      fix: "Check the URL, DNS and TLS certificate.",
    };
  }
  if (record.status === 404) {
    return {
      detail: `Nothing was found at ${record.url} (HTTP 404).`,
      fix: "Publish agent-manifest.json at the site base. For a peer URL like https://host/agents/name, the manifest must be at https://host/agents/agent-manifest.json.",
    };
  }
  return {
    detail: `The request returned HTTP ${record.status}${record.error ? `: ${record.error}` : ""}.`,
    fix: "Make the file publicly readable with a plain GET.",
  };
}

function checkManifestFetch(report, record) {
  if (!record.ok) {
    const { detail, fix } = describeFetchFailure(record);
    report.add({
      id: "manifest.fetch", group: "files", section: "3.3", level: "must", status: "fail",
      title: "agent-manifest.json is readable from another origin",
      detail, fix, evidence: [record.url],
    });
    return null;
  }
  const redirected = originOf(record.finalUrl) !== originOf(record.url);
  report.add({
    id: "manifest.fetch", group: "files", section: "3.3", level: "must", status: "pass",
    title: "agent-manifest.json is readable from another origin",
    detail: `Read ${plural(record.bytes, "character")} with CORS, without cookies${redirected ? `, after a redirect to ${originOf(record.finalUrl)}` : ""}.`,
    evidence: [record.url],
  });
  if (redirected) {
    report.add({
      id: "manifest.redirect", group: "files", section: "5", level: "should", status: "warn",
      title: "Manifest redirects to another origin",
      detail: `The manifest at ${originOf(record.url)} redirects to ${originOf(record.finalUrl)}. Runtimes treat a redirect to another origin as a new destination that needs its own consent.`,
      fix: "Publish the manifest at its final address, or link to that address directly.",
      evidence: [record.url, record.finalUrl],
    });
  }
  let manifest;
  try {
    manifest = JSON.parse(record.text);
  } catch (error) {
    report.add({
      id: "manifest.json", group: "files", section: "3.3", level: "must", status: "fail",
      title: "agent-manifest.json is valid JSON",
      detail: `It does not parse as JSON: ${error.message}`,
      fix: "Publish the manifest as plain JSON.", evidence: [record.url],
    });
    return null;
  }
  if (!isObject(manifest)) {
    report.add({
      id: "manifest.json", group: "files", section: "3.3", level: "must", status: "fail",
      title: "agent-manifest.json is valid JSON", detail: "The manifest is not a JSON object.",
      evidence: [record.url],
    });
    return null;
  }
  return manifest;
}

function checkManifestContent(report, manifest, chosen) {
  const networks = Array.isArray(manifest.networks) ? manifest.networks : null;
  report.add({
    id: "manifest.networks", group: "files", section: "3.3", level: "must",
    status: networks && networks.length ? "pass" : "fail",
    title: "Manifest lists at least one network",
    detail: networks && networks.length
      ? `Lists ${plural(networks.length, "network")}: ${networks.map((n) => n?.name).join(", ")}.`
      : "The manifest has no non-empty \"networks\" array.",
    fix: networks && networks.length ? "" : 'Add "networks": [{"name", "front_man", "hocon"}].',
  });
  if (!networks || !networks.length) return [];

  const missing = [];
  networks.forEach((entry, index) => {
    for (const field of ["name", "front_man", "hocon"]) {
      if (!isObject(entry) || typeof entry[field] !== "string" || !entry[field].trim()) {
        missing.push(`networks[${index}].${field}`);
      }
    }
  });
  report.add({
    id: "manifest.fields", group: "files", section: "3.3", level: "must",
    status: missing.length ? "fail" : "pass",
    title: "Each network has name, front_man and hocon",
    detail: missing.length ? `Missing or empty: ${missing.join(", ")}.` : "Every entry names its network, front agent and network file.",
    fix: missing.length ? "Give every manifest entry a name, the front agent's name (front_man) and the network file's location (hocon)." : "",
  });

  const names = networks.map((n) => n?.name).filter(Boolean);
  const duplicates = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
  report.add({
    id: "manifest.unique", group: "files", section: "3.2", level: "must",
    status: duplicates.length ? "fail" : "pass",
    title: "Network names are unique",
    detail: duplicates.length
      ? `More than one entry is named ${duplicates.join(", ")}. A caller asks for a network by exact name, so this is ambiguous.`
      : "A caller can pick each network by its exact name.",
  });

  const router = manifest.llm_router;
  const hasRouter = isObject(router) && (typeof router.base_url === "string" || typeof router.byok_router === "string");
  report.add({
    id: "manifest.router", group: "inference", section: "4", level: "must",
    status: hasRouter ? "pass" : "fail",
    title: "Manifest declares the site's LLM router",
    detail: hasRouter
      ? [
          router.base_url ? `Default router: ${router.base_url}${router.mock ? " (mock)" : ""}.` : "No default router.",
          router.byok_router ? `Visitors can bring their own key through ${router.byok_router}.` : "No BYOK router.",
        ].join(" ")
      : "The manifest has no llm_router with base_url or byok_router, so a runtime has no inference path for this site.",
    fix: hasRouter ? "" : 'Add "llm_router": {"base_url": "https://…", "byok_router": "https://…"}.',
  });
  if (hasRouter) {
    const insecure = ["base_url", "byok_router"]
      .map((key) => router[key])
      .filter((value) => typeof value === "string" && value.startsWith("http://") && !isLoopback(value));
    report.add({
      id: "manifest.router_https", group: "inference", section: "4", level: "should",
      status: insecure.length ? "warn" : "pass",
      title: "Router uses HTTPS",
      detail: insecure.length ? `These routers use plain HTTP: ${insecure.join(", ")}. Keys would travel unencrypted.` : "Model requests and keys go over HTTPS.",
    });
  }

  const policy = manifest.peer_policy || manifest.web_policy;
  const hasPolicy = isObject(policy) || Array.isArray(manifest.allowed_peers);
  report.add({
    id: "manifest.peer_policy", group: "files", section: "3.3", level: "must",
    status: hasPolicy ? "pass" : "fail",
    title: "Manifest states its peer policy",
    detail: hasPolicy
      ? policy?.mode === "open"
        ? "Open: any HTTPS peer may be contacted, each after the visitor approves it."
        : `Closed: only ${Array.isArray(manifest.allowed_peers) && manifest.allowed_peers.length ? manifest.allowed_peers.join(", ") : "peers the visitor links"} may be contacted.`
      : "Neither peer_policy nor allowed_peers is present, so callers cannot tell which peer origins this site may contact.",
    fix: hasPolicy ? "" : 'Add "peer_policy": {"mode": "closed"} and "allowed_peers": [...], or "mode": "open".',
  });

  // Which networks to check.
  if (chosen.network) {
    const exact = networks.filter((n) => n?.name === chosen.network);
    report.add({
      id: "manifest.exact_match", group: "files", section: "3.2", level: "must",
      status: exact.length === 1 ? "pass" : "fail",
      title: `Network "${chosen.network}" is published under that exact name`,
      detail: exact.length === 1
        ? `The URL asks for "${chosen.network}" and the manifest has exactly one entry with that name.`
        : `The URL asks for "${chosen.network}", but the manifest lists ${names.join(", ") || "nothing"}. A runtime must fail rather than run a different network.`,
      fix: exact.length === 1 ? "" : `Link to one of the published names, or publish a network named "${chosen.network}".`,
    });
    return exact.length ? exact : [];
  }
  if (chosen.networkFile) {
    const match = networks.filter((n) => typeof n?.hocon === "string" && resolveAgainst(chosen.base, n.hocon) === chosen.networkFile);
    if (match.length) return match;
  }
  return networks.filter((n) => isObject(n) && typeof n.hocon === "string");
}

function checkSecrets(report, doc, url) {
  const findings = findSecrets(doc, url);
  const file = url.split("/").pop();
  report.add({
    id: `secrets.${file}`, group: "inference", section: "4", level: "must",
    status: findings.length ? "fail" : "pass",
    title: `No credentials in ${file}`,
    detail: findings.length
      ? `Found ${plural(findings.length, "possible credential")}. Anything in a published file is public; rotate these keys now.`
      : "No API keys, tokens or passwords were found.",
    evidence: findings.map((f) => `${f.path}: ${f.kind}, ${f.masked}`),
    fix: findings.length ? "Delete the key from the file, revoke it with its provider, and let visitors bring their own key (BYOK) instead." : "",
  });
}

async function checkNetwork(report, { entry, manifest, base, links, linksRecord, fetchImpl, mayContact, deep }) {
  const name = entry.name;
  const url = resolveAgainst(base, entry.hocon);
  const tag = { network: name };
  const summary = { name, front_man: entry.front_man, hocon: url, agents: [], externals: [], mcps: [], linkSlots: [], sampleQueries: [] };
  report.networks.push(summary);

  if (originOf(url) !== originOf(base) && !(await mayContact(url, `read the network file for "${name}"`))) {
    report.add({ ...tag, id: "network.consent", group: "network", section: "5", level: "info", status: "skip", title: `Network file for "${name}"`, detail: `You declined to contact ${originOf(url)}.` });
    return;
  }
  const record = await fetchPublic(url, fetchImpl);
  report.addFile(record, "network");
  if (!url.startsWith("https://") && !isLoopback(url)) {
    report.add({ ...tag, id: "network.https", group: "network", section: "3.3", level: "must", status: "fail", title: "Network file is served over HTTPS", detail: `${url} uses plain HTTP.`, fix: "Publish the network file over HTTPS." });
  }
  if (!record.ok) {
    const { detail, fix } = describeFetchFailure(record);
    report.add({ ...tag, id: "network.fetch", group: "network", section: "3.3", level: "must", status: "fail", title: `Network file for "${name}" is readable from another origin`, detail, fix, evidence: [url] });
    return;
  }
  report.add({ ...tag, id: "network.fetch", group: "network", section: "3.3", level: "must", status: "pass", title: `Network file for "${name}" is readable from another origin`, detail: `Read ${plural(record.bytes, "character")} with CORS.`, evidence: [url] });

  // Published as JSON (3.3). HOCON text still parses with the runtime's parser.
  let config;
  try {
    config = JSON.parse(record.text);
    report.add({ ...tag, id: "network.json", group: "network", section: "3.3", level: "must", status: "pass", title: "Network is published as resolved JSON", detail: "The browser can load it without a HOCON parser." });
  } catch {
    try {
      config = parseHocon(record.text);
      report.add({ ...tag, id: "network.json", group: "network", section: "3.3", level: "must", status: "fail", title: "Network is published as resolved JSON", detail: "The file is HOCON text, not JSON. The reference runtime can parse it, but the spec asks for a resolved JSON document for browser loading.", fix: "Build the .network.json from your .hocon (JSON is valid HOCON) and point the manifest's hocon field at it." });
    } catch (error) {
      report.add({ ...tag, id: "network.json", group: "network", section: "3.3", level: "must", status: "fail", title: "Network is published as resolved JSON", detail: `It is neither JSON nor HOCON the runtime can parse: ${error.message}` });
      return;
    }
  }
  if (!isObject(config)) {
    report.add({ ...tag, id: "network.shape", group: "network", section: "3.1", level: "must", status: "fail", title: "Network passes the reference runtime's validator", detail: "The network is not an object." });
    return;
  }

  checkSecrets(report, config, url);
  checkDataOnly(report, config, tag);

  // The reference runtime's own parser model and validator (3.1).
  const network = new AgentNetwork(config, name);
  const validation = validateNetwork(network);
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const agentNames = tools.map((a) => a?.name).filter((n) => typeof n === "string");
  const dupes = [...new Set(agentNames.filter((n, i) => agentNames.indexOf(n) !== i))];
  const errors = [...validation.errors, ...dupes.map((n) => `More than one agent is named '${n}'.`)];
  report.add({
    ...tag, id: "network.shape", group: "network", section: "3.1", level: "must",
    status: errors.length ? "fail" : "pass",
    title: "Network passes the reference runtime's validator",
    detail: errors.length
      ? `The runtime would reject this network before any model call: ${plural(errors.length, "error")}.`
      : `${plural(tools.length, "agent")}, no missing references, a front agent, unique names.`,
    evidence: errors,
    fix: errors.length ? "Fix each error. A reference to another network must be a full https URL, a declared link slot, or the name of an agent in this file." : "",
  });
  if (!tools.length) return;

  summary.sampleQueries = (config.metadata?.sample_queries || entry.sample_queries || []).filter((q) => typeof q === "string");
  summary.linkSlots = [...network.linkSlots];

  // Front agent (2.1).
  const runtimeFront = find_front_man(config);
  const declared = entry.front_man;
  let frontStatus = "pass";
  let frontDetail = `The manifest names "${declared}", and the reference runtime starts from the same agent.`;
  let frontFix = "";
  if (!agentNames.includes(declared)) {
    frontStatus = "fail";
    frontDetail = `The manifest names "${declared}" as front agent, but the network has no agent with that name.`;
    frontFix = `Set front_man to an agent in the network, such as "${runtimeFront}".`;
  } else if (runtimeFront !== declared) {
    frontStatus = "fail";
    frontDetail = `The manifest names "${declared}", but the reference runtime starts from "${runtimeFront}": the first agent with instructions. Callers would run a different entry point than you published.`;
    frontFix = `Move "${declared}" to the top of the tools list, or set front_man to "${runtimeFront}".`;
  }
  report.add({ ...tag, id: "network.front_man", group: "network", section: "2.1", level: "must", status: frontStatus, title: "Front agent matches the manifest", detail: frontDetail, fix: frontFix });

  const description = config.metadata?.description || entry.description;
  report.add({
    ...tag, id: "network.description", group: "network", section: "2.1", level: "should",
    status: description ? "pass" : "warn",
    title: "Network has a short description",
    detail: description ? `"${String(description).slice(0, 160)}"` : "Neither metadata.description nor the manifest entry describes the network, so callers cannot tell when to use it.",
    fix: description ? "" : "Add metadata.description to the network.",
  });

  // Agents (2.1).
  const called = new Set();
  for (const agent of tools) for (const ref of agent?.tools || []) if (typeof ref === "string") called.add(ref);
  const noDescription = [];
  const noInstructions = [];
  const noToolsList = [];
  const badSchemas = [];
  const coded = [];
  const toolbox = [];
  const inventing = [];
  const long = [];
  for (const agent of tools) {
    if (!isObject(agent)) continue;
    const kind = agent.class ? "coded" : agent.toolbox ? "toolbox" : "agent";
    summary.agents.push({ name: agent.name, kind, tools: (agent.tools || []).map((t) => (typeof t === "string" ? t : t?.url || "mcp")) });
    if (!agent.function?.description) noDescription.push(agent.name);
    if (kind === "agent" && !agent.instructions) noInstructions.push(agent.name);
    if (kind === "agent" && !Array.isArray(agent.tools)) noToolsList.push(agent.name);
    if (kind === "coded") coded.push(agent.name);
    if (kind === "toolbox") toolbox.push(agent.name);
    if (called.has(agent.name)) {
      const problems = agent.function?.parameters === undefined ? ["no function.parameters"] : schemaProblems(agent.function.parameters);
      if (problems.length) badSchemas.push(`${agent.name}: ${problems.join("; ")}`);
    }
    const text = typeof agent.instructions === "string" ? network.getAgentSpec(agent.name)?.instructions || agent.instructions : "";
    if (/make up a realistic|invent (a |realistic )?(response|data)|demo_mode/i.test(text)) inventing.push(agent.name);
    if (text.length > 6000) long.push(`${agent.name} (${text.length.toLocaleString()} characters)`);
  }
  report.add({ ...tag, id: "agent.description", group: "network", section: "2.1", level: "must", status: noDescription.length ? "fail" : "pass", title: "Every agent describes what it does", detail: noDescription.length ? `No function.description: ${noDescription.join(", ")}.` : "Callers can choose agents by their descriptions.", fix: noDescription.length ? "Add function.description to each agent." : "" });
  report.add({ ...tag, id: "agent.instructions", group: "network", section: "2.1", level: "must", status: noInstructions.length ? "fail" : "pass", title: "Every LLM agent has instructions", detail: noInstructions.length ? `No instructions: ${noInstructions.join(", ")}.` : "Each LLM agent has instructions." });
  report.add({ ...tag, id: "agent.tools_list", group: "network", section: "2.1", level: "should", status: noToolsList.length ? "warn" : "pass", title: "Every agent lists what it may call", detail: noToolsList.length ? `No "tools" list: ${noToolsList.join(", ")}. An empty list states that an agent calls nothing.` : "Each agent declares its downstream agents and tools." });
  report.add({ ...tag, id: "agent.parameters", group: "network", section: "2.1", level: "must", status: badSchemas.length ? "fail" : "pass", title: "Callable agents have JSON Schema inputs", detail: badSchemas.length ? "These agents are called by other agents but their input schema is missing or unusable." : "Each agent that another agent calls exposes an object schema.", evidence: badSchemas, fix: badSchemas.length ? 'Give each called agent "function": {"parameters": {"type": "object", "properties": {"request": {"type": "string"}}, "required": ["request"]}}.' : "" });
  if (coded.length) {
    const bundle = manifest.coded_tools?.bundle;
    report.add({ ...tag, id: "agent.coded", group: "portability", section: "3.1", level: "must", status: bundle ? "pass" : "fail", title: "Coded tools come with a declared bundle", detail: bundle ? `Coded tools (${coded.join(", ")}) run from ${bundle} in an isolated Web Worker.` : `Coded tools (${coded.join(", ")}) have no coded_tools.bundle in the manifest. Runtimes must reject unsupported executable definitions.`, fix: bundle ? "" : "Declare coded_tools.bundle in the manifest, or replace the coded tools with site actions or MCP." });
    if (bundle) {
      report.add({ ...tag, id: "agent.coded_sri", group: "portability", section: "5", level: "should", status: manifest.coded_tools?.integrity ? "pass" : "warn", title: "Coded-tool bundle has an SRI digest", detail: manifest.coded_tools?.integrity ? "Runtimes verify the bundle before running it." : "Without coded_tools.integrity, a changed bundle runs without notice. A digest is optional in this profile.", fix: manifest.coded_tools?.integrity ? "" : 'Add "integrity": "sha384-…" next to the bundle.' });
    }
  }
  if (toolbox.length) {
    report.add({ ...tag, id: "agent.toolbox", group: "portability", section: "2.2", level: "should", status: "warn", title: "Toolbox tools run in the browser", detail: `Toolbox tools (${toolbox.join(", ")}) depend on a backend. Only the reference runtime's built-in REST toolbox runs in a browser; other runtimes may not.`, fix: "Prefer site actions or MCP for portable tools." });
  }
  report.add({ ...tag, id: "agent.grounding", group: "network", section: "3.1", level: "should", status: inventing.length ? "warn" : "pass", title: "Instructions do not ask the model to invent results", detail: inventing.length ? `${inventing.join(", ")} tell the model to make up realistic responses. Visitors cannot tell an invented status from a real one.` : "No agent is told to make up data.", fix: inventing.length ? "Remove demo instructions and answer from tool results or say the information is unavailable." : "" });
  if (long.length) {
    report.add({ ...tag, id: "agent.size", group: "network", section: "2.1", level: "info", status: "info", title: "Long instructions", detail: `Every call sends these in full with the visitor's key: ${long.join(", ")}.` });
  }

  // Reachability from the front agent.
  const reachable = new Set();
  const stack = [runtimeFront];
  while (stack.length) {
    const current = stack.pop();
    if (reachable.has(current)) continue;
    reachable.add(current);
    const spec = tools.find((a) => a?.name === current);
    for (const ref of spec?.tools || []) if (typeof ref === "string" && agentNames.includes(ref)) stack.push(ref);
  }
  const unused = agentNames.filter((n) => !reachable.has(n));
  if (unused.length) {
    report.add({ ...tag, id: "agent.unreachable", group: "network", section: "2.1", level: "info", status: "info", title: "Agents the front agent cannot reach", detail: `${unused.join(", ")} ${unused.length === 1 ? "is" : "are"} published but no path from ${runtimeFront} calls ${unused.length === 1 ? "it" : "them"}.` });
  }

  await checkReferences(report, { tag, config, network, manifest, base, links, summary, mayContact, fetchImpl, deep });
  checkPortability(report, { tag, config, manifest, base });
}

function checkDataOnly(report, config, tag) {
  const problems = [];
  walk(config, ({ key, value, path }) => {
    if (key === "include") problems.push(`${path}: an include directive`);
    if (typeof value !== "string") return;
    if (/\$\{\??[^}]+\}/.test(value)) problems.push(`${path}: an unresolved substitution ${value.match(/\$\{\??[^}]+\}/)[0]}`);
    if (/^(file:\/\/|\/Users\/|\/home\/|\/var\/|\/tmp\/|[A-Za-z]:\\)/.test(value)) problems.push(`${path}: a local file path`);
  });
  report.add({
    ...tag, id: "network.data_only", group: "network", section: "2.2", level: "must",
    status: problems.length ? "fail" : "pass",
    title: "Network is data only, with nothing left to resolve",
    detail: problems.length
      ? "The published network still depends on the publisher's machine."
      : "No includes, substitutions or local file paths.",
    evidence: problems.slice(0, 12),
    fix: problems.length ? "Resolve includes and substitutions when you build the published JSON, and remove local paths." : "",
  });
}

async function checkReferences(report, { tag, config, network, manifest, base, links, summary, mayContact, fetchImpl, deep }) {
  const remotes = [];
  const mcps = [];
  for (const agent of config.tools || []) {
    for (const ref of agent?.tools || []) {
      const kind = network.classifyTool(ref).kind;
      if (kind === "remote") remotes.push({ agent: agent.name, ref });
      if (kind === "mcp") mcps.push({ agent: agent.name, ref });
    }
  }
  summary.externals = remotes.map((r) => r.ref);
  summary.mcps = mcps.map((m) => (typeof m.ref === "string" ? m.ref : m.ref?.url));

  // Peer-network references (3.2).
  if (remotes.length) {
    const bad = [];
    for (const { agent, ref } of remotes) {
      if (ref.startsWith("/")) continue;
      let parsed;
      try { parsed = new URL(ref); } catch { bad.push(`${agent} → ${ref}: not a URL`); continue; }
      const last = parsed.pathname.split("/").filter(Boolean).pop();
      if (!last || parsed.pathname.endsWith("/")) bad.push(`${agent} → ${ref}: no network name at the end of the path`);
      if (parsed.protocol !== "https:" && !isLoopback(ref)) bad.push(`${agent} → ${ref}: not HTTPS`);
    }
    report.add({ ...tag, id: "refs.peer_urls", group: "peers", section: "3.2", level: "must", status: bad.length ? "fail" : "pass", title: "Peer references are HTTPS URLs ending in a network name", detail: bad.length ? "A peer URL must be https://host/path/<network-name>." : `${plural(remotes.length, "peer reference")}: ${remotes.map((r) => r.ref).join(", ")}.`, evidence: bad });

    const policy = manifest.peer_policy || manifest.web_policy;
    if (policy?.mode !== "open") {
      const allowed = new Set((manifest.allowed_peers || []).map(originOf));
      const blocked = [...new Set(remotes.filter((r) => !r.ref.startsWith("/")).map((r) => originOf(r.ref)).filter((o) => o && o !== originOf(base) && !allowed.has(o)))];
      report.add({ ...tag, id: "refs.peer_policy", group: "peers", section: "3.2", level: "must", status: blocked.length ? "fail" : "pass", title: "Your peer policy allows the peers you reference", detail: blocked.length ? `The peer policy is closed and allowed_peers does not include ${blocked.join(", ")}, so the runtime will refuse to contact ${blocked.length === 1 ? "it" : "them"}.` : "Every referenced peer origin is in allowed_peers.", fix: blocked.length ? `Add ${blocked.map((o) => `"${o}"`).join(", ")} to allowed_peers.` : "" });
    }

    if (deep) {
      for (const { ref } of remotes) {
        if (ref.startsWith("/")) continue;
        await checkPeerExists(report, { tag, ref, mayContact, fetchImpl });
      }
    }
  }

  // MCP descriptors (2.1, 3.4).
  if (mcps.length) {
    const bad = [];
    for (const { agent, ref } of mcps) {
      const url = typeof ref === "string" ? ref : ref?.url;
      if (typeof url !== "string") { bad.push(`${agent}: MCP descriptor has no url`); continue; }
      if (!url.startsWith("https://") && !isLoopback(url)) bad.push(`${agent} → ${url}: not HTTPS`);
      if (isObject(ref) && ref.tools !== undefined && !(Array.isArray(ref.tools) && ref.tools.every((t) => typeof t === "string"))) bad.push(`${agent} → ${url}: tools is not a list of names`);
    }
    report.add({ ...tag, id: "refs.mcp", group: "peers", section: "2.1", level: "must", status: bad.length ? "fail" : "pass", title: "MCP servers are HTTPS descriptors", detail: bad.length ? "Fix these MCP descriptors." : `${plural(mcps.length, "MCP server")}. A browser calls them directly, so each must allow CORS for the calling site, and the runtime asks the visitor before contacting them.`, evidence: bad });
  }

  // Link slots (3.3).
  const slots = [...network.linkSlots];
  if (slots.length) {
    const bound = links?.networks?.[network.name] || {};
    const unbound = slots.filter((slot) => !bound[slot]);
    report.add({ ...tag, id: "refs.link_slots", group: "peers", section: "3.3", level: "info", status: "info", title: "Named peer links", detail: `${plural(slots.length, "link slot")}: ${slots.join(", ")}.${unbound.length ? ` Not bound in links.json: ${unbound.join(", ")}. The runtime asks the visitor for a URL when an agent first calls ${unbound.length === 1 ? "it" : "them"}.` : " All are bound in links.json."}` });
  }

  // Private context (2.1, 5).
  const rules = slyRules(config);
  const crossesBoundary = remotes.length || mcps.length || slots.length;
  const wildcard = rules.filter((r) => r.fields.includes("*"));
  let status = "pass";
  let detail;
  if (!rules.length) {
    detail = crossesBoundary
      ? "No allow rules, so no private-context field leaves this network: deny by default."
      : "The network makes no cross-site calls, so private context never leaves it.";
  } else if (wildcard.length) {
    status = crossesBoundary ? "fail" : "warn";
    detail = `Allow rules pass every private-context field (${wildcard.map((r) => `${r.agent} ${r.direction}`).join(", ")}). The spec allows only explicitly named fields to cross.`;
  } else {
    detail = `Only named fields cross: ${rules.map((r) => `${r.agent} ${r.direction}: ${r.fields.join(", ") || "none"}`).join("; ")}.`;
  }
  report.add({ ...tag, id: "refs.private_context", group: "peers", section: "5", level: "must", status, title: "Private context crosses only by named fields", detail, fix: wildcard.length ? "Replace the wildcard with the exact field names a peer needs." : "" });
}

async function checkPeerExists(report, { tag, ref, mayContact, fetchImpl }) {
  const parsed = new URL(ref);
  const name = parsed.pathname.split("/").filter(Boolean).pop();
  const peerBase = new URL("./", parsed).href.replace(/\/$/, "");
  const manifestUrl = `${peerBase}/agent-manifest.json`;
  if (!(await mayContact(manifestUrl, `check that it publishes "${name}"`))) {
    report.add({ ...tag, id: `refs.peer_exists.${name}`, group: "peers", section: "3.2", level: "info", status: "skip", title: `Peer "${name}" is published`, detail: `You declined to contact ${parsed.origin}.` });
    return;
  }
  const record = await fetchPublic(manifestUrl, fetchImpl);
  report.addFile(record, "peer");
  let found = false;
  let detail;
  if (!record.ok) {
    detail = describeFetchFailure(record).detail;
  } else {
    try {
      const doc = JSON.parse(record.text);
      found = (doc.networks || []).some((n) => n?.name === name);
      detail = found ? `${parsed.origin} publishes "${name}".` : `${parsed.origin} does not publish a network named "${name}". It lists ${(doc.networks || []).map((n) => n?.name).join(", ") || "nothing"}.`;
    } catch {
      detail = "The peer's manifest is not valid JSON.";
    }
  }
  report.add({ ...tag, id: `refs.peer_exists.${name}`, group: "peers", section: "3.2", level: "must", status: found ? "pass" : "fail", title: `Peer "${name}" is published`, detail, evidence: [manifestUrl] });
}

function checkPortability(report, { tag, config, manifest }) {
  // Site actions belong to the publisher's page. When another site loads this network,
  // they are not there (cross-site actions are an extension, spec 3.2 MVP boundary).
  const actionTools = Array.isArray(manifest.actions?.agentTools) ? manifest.actions.agentTools : [];
  const mentioned = new Set();
  walk(config, ({ value }) => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(/\bwebsite_([A-Za-z][A-Za-z0-9_-]*)/g)) mentioned.add(match[1]);
  });
  const depends = [...new Set([...actionTools, ...mentioned])];
  if (depends.length) {
    report.add({
      ...tag, id: "portable.site_actions", group: "portability", section: "3.2", level: "should", status: "warn",
      title: "Works without the publisher's page",
      detail: `The agents rely on page-local site actions (${depends.map((n) => `website_${n}`).join(", ")}). When another site loads this network, those tools do not exist: cross-site actions are an extension outside the MVP profile. Peers will get answers that cannot read your data.`,
      fix: "Tell agents what to say when a website_* tool is missing, or publish a second, portable network without them for other sites to load.",
    });
  } else {
    report.add({ ...tag, id: "portable.site_actions", group: "portability", section: "3.2", level: "should", status: "pass", title: "Works without the publisher's page", detail: "No agent depends on page-local site actions, so the network behaves the same when another site loads it." });
  }
  // The reference runtime registers a peer's declared actions through an action bridge
  // page on the peer's origin. With actions but no bridge, it tries <base>/undefined,
  // waits about 10 seconds, then asks the visitor to open a window on the peer's site,
  // and the peer fails to load if they cancel (tested in Chromium with the runtime copy
  // in cognizant-ai-labs/agentic-web, nsdeploy commit 23df164).
  if (isObject(manifest.actions)) {
    const bridge = manifest.actions.bridge;
    report.add({
      ...tag, id: "portable.action_bridge", group: "portability", section: "3.2", level: "should",
      status: bridge ? "pass" : "warn",
      title: "Other sites can load it without an action bridge prompt",
      detail: bridge
        ? `The manifest declares an action bridge at ${bridge} for callers on other origins.`
        : "The manifest declares page actions but no actions.bridge. When another site loads this network, the reference runtime first tries to reach an action bridge on your origin, waits about 10 seconds, then asks the visitor to open a window on your site. If they cancel, the network does not load.",
      fix: bridge ? "" : "Publish a portable copy of the network under its own site base, with a manifest that has no actions block, and link other sites to that copy. Or provide an action bridge page (nsDeploy's cross-site actions extension).",
    });
  }
  const models = new Set();
  walk(config, ({ key, value }) => { if (key === "model_name" && typeof value === "string") models.add(value); });
  if (models.size) {
    report.add({ ...tag, id: "portable.models", group: "portability", section: "2.1", level: "info", status: "info", title: "Model settings are hints", detail: `The network suggests ${[...models].join(", ")}. A caller runs it with the caller's own router and model.` });
  }
}

function checkLinksFile(report, links, record, entries) {
  const needsLinks = report.networks.some((n) => n.linkSlots.length);
  if (!record.ok) {
    report.add({
      id: "links.fetch", group: "files", section: "3.3", level: needsLinks ? "should" : "info",
      status: needsLinks ? "warn" : "info",
      title: "links.json",
      detail: record.corsBlocked
        ? "links.json exists but is not readable from other origins."
        : needsLinks
          ? "No links.json. Your network has link slots, so without default bindings the runtime asks every visitor for the URLs."
          : "No links.json. That is fine: no network uses named peer links.",
      evidence: [record.url],
    });
    return;
  }
  if (links === undefined) {
    report.add({ id: "links.json", group: "files", section: "3.3", level: "must", status: "fail", title: "links.json is valid JSON", detail: "links.json does not parse as JSON.", evidence: [record.url] });
    return;
  }
  const problems = [];
  if (!isObject(links) || !isObject(links.networks)) problems.push('No "networks" object.');
  else {
    for (const [net, bindings] of Object.entries(links.networks)) {
      if (!isObject(bindings)) { problems.push(`networks.${net} is not an object`); continue; }
      for (const [ref, target] of Object.entries(bindings)) {
        let parsed;
        try { parsed = new URL(target); } catch { problems.push(`${net}.${ref}: "${target}" is not a URL`); continue; }
        if (!["https:", "http:"].includes(parsed.protocol)) problems.push(`${net}.${ref}: not http(s)`);
        else if (parsed.protocol === "http:" && !isLoopback(target)) problems.push(`${net}.${ref}: not HTTPS`);
        if (!parsed.pathname.split("/").filter(Boolean).pop()) problems.push(`${net}.${ref}: no network name at the end of ${target}`);
      }
    }
  }
  report.add({
    id: "links.shape", group: "files", section: "3.3", level: "must", status: problems.length ? "fail" : "pass",
    title: "links.json maps names to peer-network URLs",
    detail: problems.length ? "Some bindings are malformed." : `${Object.keys(links.networks || {}).length ? "Bindings are well formed." : "No bindings yet."}`,
    evidence: problems,
  });
}

async function checkDiscovery(report, base, fetchImpl) {
  const optional = [
    { id: "discovery.nsdeploy", path: ".well-known/nsdeploy.json", title: ".well-known/nsdeploy.json", note: "site identity for nsDeploy tools" },
    { id: "discovery.agent_mcp", path: "agent-mcp.json", title: "agent-mcp.json", note: "states whether a public MCP facade exists" },
  ];
  for (const file of optional) {
    const record = await fetchPublic(`${base}/${file.path}`, fetchImpl);
    report.addFile(record, "discovery");
    report.add({ id: file.id, group: "discovery", section: "3.3", level: "info", status: "info", title: file.title, detail: record.ok ? `Published (${file.note}).` : `Not published. Optional: ${file.note}.`, evidence: [record.url] });
  }
}

async function checkChallenge(report, base, manifest, fetchImpl) {
  // The Open Agentic Web Challenge's submission list, not spec requirements.
  const page = await fetchPublic(`${base}/`, fetchImpl);
  report.addFile(page, "page");
  const html = page.ok ? page.text : "";
  const RUNTIME = /runtime\/index\.js|\bboot\s*\(|data-nsdeploy-ui|nsdeploy/i;
  let runtime = RUNTIME.test(html);
  // The runtime is usually imported by one of the page's own module scripts.
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 4);
  for (const src of scripts) {
    if (runtime) break;
    let url;
    try { url = new URL(src, `${base}/`).href; } catch { continue; }
    if (originOf(url) !== originOf(base)) continue;
    const script = await fetchPublic(url, fetchImpl);
    if (script.ok && RUNTIME.test(script.text)) runtime = true;
  }
  report.add({
    id: "challenge.public_url", group: "challenge", section: "challenge", level: "info",
    status: page.ok ? "pass" : "info",
    title: "A public page at the site URL",
    detail: page.ok ? "The site URL returns a page." : "Preflight could not read a page at the site URL from another origin. Judges open it in a normal browser, so this may still be fine.",
  });
  report.add({
    id: "challenge.json", group: "challenge", section: "challenge", level: "info",
    status: report.files.some((f) => f.role === "network" && f.ok) ? "pass" : "info",
    title: "A public .json file describing the agent network",
    detail: report.files.some((f) => f.role === "network" && f.ok) ? "Found and readable." : "Not found or not readable from another origin.",
  });
  report.add({
    id: "challenge.runtime", group: "challenge", section: "challenge", level: "info",
    status: runtime ? "pass" : "info",
    title: "A runtime that runs the network in the browser",
    detail: runtime ? "The page loads an agent runtime." : page.ok ? "The page does not seem to load a browser runtime. Preflight looks for runtime/index.js or a boot() call." : "Not checked: the page was not readable.",
  });
  if (manifest) {
    report.add({
      id: "challenge.byok", group: "challenge", section: "challenge", level: "info",
      status: manifest.llm_router?.byok_router ? "pass" : "info",
      title: "Visitors can choose their LLM and key (optional)",
      detail: manifest.llm_router?.byok_router ? "The manifest publishes a BYOK router." : "No BYOK router is published. This is optional.",
    });
  }
}
