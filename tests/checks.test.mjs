// Tests for Preflight's checks, exports, spec reader and website actions.
// Run with: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runPreflight, parseTarget, findSecrets, schemaProblems, slyRules } from "../js/checks.js";
import { toMarkdown, compactReport, badgeFor } from "../js/export.js";
import { splitSpec, SPEC_SECTIONS } from "../js/spec.js";
import { fileFetch } from "./file-fetch.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CDN = "https://cdn.jsdelivr.net/gh/adrian-erlikhman/preflight@main";
const SITE = "https://adrian-erlikhman.github.io/preflight";

function hostedFetch(options = {}) {
  return fileFetch({ [CDN]: ROOT, [SITE]: ROOT }, options);
}

const ids = (report, status) => report.checks.filter((c) => c.status === status).map((c) => c.id);

test("parseTarget reads every form of site URL", () => {
  assert.deepEqual(parseTarget("https://a.example/agents/trail_guide").candidates[0], { base: "https://a.example/agents", network: "trail_guide", how: "peer-network URL" });
  assert.equal(parseTarget("https://a.example/agents/trail_guide").candidates[1].base, "https://a.example/agents/trail_guide");
  assert.equal(parseTarget("https://a.example/site/").candidates[0].base, "https://a.example/site");
  assert.equal(parseTarget("https://a.example/site/agent-manifest.json").candidates[0].base, "https://a.example/site");
  assert.equal(parseTarget("https://a.example/site/x.network.json").candidates[0].networkFile, "https://a.example/site/x.network.json");
  assert.equal(parseTarget("https://a.example/site/index.html").candidates[0].base, "https://a.example/site");
  assert.equal(parseTarget("a.example/").url, "https://a.example/");
  assert.equal(parseTarget("ftp://a.example/").ok, false);
  assert.equal(parseTarget("").ok, false);
});

test("Preflight's portable peer network passes every check", async () => {
  const report = await runPreflight(`${CDN}/peer/spec_helper`, { fetch: hostedFetch() });
  assert.equal(report.interpretation, "peer-network URL");
  assert.equal(report.requestedNetwork, "spec_helper");
  assert.deepEqual(ids(report, "fail"), []);
  assert.ok(ids(report, "pass").includes("manifest.exact_match"));
  assert.ok(ids(report, "pass").includes("portable.site_actions"));
  assert.equal(report.summary.ready, true);
});

test("Preflight's own site passes required checks and is honest about its page actions", async () => {
  const report = await runPreflight(`${SITE}/`, { fetch: hostedFetch() });
  assert.deepEqual(ids(report, "fail"), []);
  assert.ok(ids(report, "warn").includes("portable.site_actions"));
  assert.ok(ids(report, "warn").includes("portable.action_bridge"));
  assert.ok(ids(report, "pass").includes("challenge.runtime"), "the page loads the runtime through site.js");
  assert.equal(report.summary.verdicts.publishes.ok, true);
});

test("the common-mistakes sample trips every check its README lists", async () => {
  const report = await runPreflight(`${CDN}/fixtures/common-mistakes/`, { fetch: hostedFetch() });
  const failed = ids(report, "fail");
  for (const id of [
    "manifest.peer_policy", "secrets.agent-manifest.json", "network.data_only", "network.shape",
    "network.front_man", "agent.parameters", "refs.peer_urls", "refs.peer_policy",
    "refs.private_context", "links.shape",
  ]) assert.ok(failed.includes(id), `expected ${id} to fail`);
  const warned = ids(report, "warn");
  for (const id of ["agent.grounding", "portable.site_actions", "portable.action_bridge"]) assert.ok(warned.includes(id), `expected ${id} to warn`);
  assert.equal(report.summary.ready, false);
  const front = report.checks.find((c) => c.id === "network.front_man");
  assert.match(front.detail, /starts from "intake_router"/);
});

test("credentials are found and masked, placeholders are not", () => {
  const doc = {
    llm_router: { api_key: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
    note: "call https://x.example/v1?key=abcdefghijklmnop",
    template: { api_key: "${OTARI_API_KEY}" },
    placeholder: { token: "<your-token>" },
  };
  const findings = findSecrets(doc, "agent-manifest.json");
  assert.equal(findings.length, 2);
  for (const f of findings) assert.ok(!f.masked.includes("abcdefghijklmnopqrst"), "the full key never appears");
  assert.deepEqual(findSecrets({ instructions: "Answer in plain English." }, "x"), []);
});

test("a CORS block is told apart from a missing file and an unreachable host", async () => {
  const blocked = await runPreflight(`${CDN}/peer/spec_helper`, { fetch: hostedFetch({ noCors: ["https://cdn.jsdelivr.net"] }) });
  const fetchCheck = blocked.checks.find((c) => c.id === "manifest.fetch");
  assert.equal(fetchCheck.status, "fail");
  assert.match(fetchCheck.detail, /Access-Control-Allow-Origin/);
  assert.equal(blocked.summary.verdicts.crossOrigin.ok, false);

  const missing = await runPreflight(`${CDN}/nothing-here/`, { fetch: hostedFetch() });
  assert.match(missing.checks.find((c) => c.id === "manifest.fetch").detail, /404/);

  const down = await runPreflight("https://down.example/agents/", { fetch: hostedFetch({ unreachable: ["https://down.example"] }) });
  assert.match(down.checks.find((c) => c.id === "manifest.fetch").detail, /could not be reached/);
});

test("requests carry no credentials, and a declined origin is never contacted", async () => {
  const log = [];
  await runPreflight(`${CDN}/peer/spec_helper`, { fetch: hostedFetch({ log }) });
  assert.ok(log.length > 3);
  for (const call of log) assert.equal(call.init.credentials, "omit");

  const declinedLog = [];
  const report = await runPreflight(`${CDN}/peer/spec_helper`, {
    fetch: hostedFetch({ log: declinedLog }),
    approve: async () => false,
  });
  assert.equal(declinedLog.length, 0);
  assert.deepEqual(report.declined, ["https://cdn.jsdelivr.net"]);
});

test("a peer URL must match a published network name exactly", async () => {
  const report = await runPreflight(`${CDN}/peer/spec_helpers`, { fetch: hostedFetch() });
  const exact = report.checks.find((c) => c.id === "manifest.exact_match");
  assert.equal(exact.status, "fail");
  assert.match(exact.detail, /must fail rather than run a different network/);
  assert.equal(report.networks.length, 0);
});

test("deep mode checks that linked peers are published, after consent", async () => {
  const mounts = { [CDN]: ROOT, "https://peer.example/agents": path.join(ROOT, "peer") };
  const site = {
    "https://caller.example/agent-manifest.json": JSON.stringify({ networks: [{ name: "caller", front_man: "desk", hocon: "./caller.network.json" }], llm_router: { base_url: "https://router.example/v1" }, peer_policy: { mode: "open" } }),
    "https://caller.example/caller.network.json": JSON.stringify({ metadata: { description: "Calls a peer." }, tools: [
      { name: "desk", function: { description: "Front desk." }, instructions: "Help.", tools: ["https://peer.example/agents/spec_helper", "https://peer.example/agents/missing_one"] },
    ] }),
  };
  const files = fileFetch(mounts);
  const fetch = async (url, init) => site[url] !== undefined
    ? { ok: true, status: 200, url, headers: new Map(), text: async () => site[url] }
    : files(url, init);
  const asked = [];
  const report = await runPreflight("https://caller.example/", { fetch, deep: true, approve: async (origin) => { asked.push(origin); return true; } });
  assert.ok(asked.includes("https://peer.example"));
  assert.equal(report.checks.find((c) => c.id === "refs.peer_exists.spec_helper").status, "pass");
  assert.equal(report.checks.find((c) => c.id === "refs.peer_exists.missing_one").status, "fail");
});

test("a network published as HOCON text is parsed but flagged", async () => {
  const site = {
    "https://h.example/agent-manifest.json": JSON.stringify({ networks: [{ name: "n", front_man: "a", hocon: "./n.hocon" }], llm_router: { base_url: "https://r.example" }, allowed_peers: [] }),
    "https://h.example/n.hocon": '{\n  # a comment\n  tools: [ { name: "a", function: { description: "A." }, instructions: """Help.""", tools: [] } ]\n}',
  };
  const fetch = async (url) => site[url] !== undefined
    ? { ok: true, status: 200, url, headers: new Map(), text: async () => site[url] }
    : { ok: false, status: 404, url, headers: new Map(), text: async () => "" };
  const report = await runPreflight("https://h.example/", { fetch });
  assert.equal(report.checks.find((c) => c.id === "network.json").status, "fail");
  assert.equal(report.checks.find((c) => c.id === "network.shape").status, "pass");
});

test("schemas and private-context rules are read correctly", () => {
  assert.deepEqual(schemaProblems({ type: "object", properties: { request: { type: "string" } }, required: ["request"] }), []);
  assert.ok(schemaProblems({ type: "object", properties: {}, required: ["x"] })[0].includes('"x"'));
  assert.ok(schemaProblems("nope").length);
  const rules = slyRules({ tools: [{ name: "a", allow: { to_downstream: { sly_data: ["user_id"] }, to_upstream: { sly_data: { token: true, other: false } } } }] });
  assert.deepEqual(rules, [
    { agent: "a", direction: "to_downstream", fields: ["user_id"] },
    { agent: "a", direction: "to_upstream", fields: ["token"] },
  ]);
});

test("exports: Markdown, the assistant's compact report and the badge", async () => {
  const report = await runPreflight(`${CDN}/fixtures/common-mistakes/`, { fetch: hostedFetch() });
  const md = toMarkdown(report, `${SITE}/`);
  assert.match(md, /# Preflight report/);
  assert.match(md, /Front agent matches the manifest/);
  assert.match(md, /\[§3\.3\]\(https:\/\/github\.com/);
  const compact = compactReport(report);
  assert.equal(compact.required.failed, report.summary.must.fail);
  assert.ok(compact.needs_attention.every((c) => c.status === "fail" || c.status === "warn"));
  assert.ok(JSON.stringify(compact).length < 64 * 1024, "fits the runtime's 64 KB tool result limit");
  const badge = badgeFor(report, `${SITE}/`);
  assert.match(badge.markdown, /failing/);
  assert.match(badge.markdown, /\?url=https%3A%2F%2Fcdn\.jsdelivr\.net/);
  assert.equal(compactReport(null).ok, false);
});

test("the bundled spec splits into the sections the assistant can quote", async () => {
  const sections = splitSpec(await readFile(path.join(ROOT, "spec/worldwide_agentic_web_mvp_spec.md"), "utf8"));
  for (const number of SPEC_SECTIONS) assert.ok(sections.has(number), `section ${number}`);
  assert.match(sections.get("3.2").title, /Peer Agent Site/);
  assert.match(sections.get("3").text, /3\.4 Browser Origin Requirements/, "a section includes its subsections");
  assert.ok(!sections.get("3.1").text.includes("3.2 Protocol"));
});

test("every website action registers with the runtime's own action registry", async () => {
  const { ActionRegistry } = await import("../runtime/actions.js");
  const { registerActions } = await import("../site-actions.js");
  const registry = new ActionRegistry();
  const scope = { base: SITE, network: "preflight" };
  registerActions({ register: (definition) => registry.register(scope, definition) });
  const names = registry.catalog(scope).map((a) => a.name).sort();
  const manifest = JSON.parse(await readFile(path.join(ROOT, "agent-manifest.json"), "utf8"));
  assert.deepEqual(names, [...manifest.actions.agentTools].sort());
  assert.ok(registry.catalog(scope).every((a) => a.effect !== "irreversible"), "Preflight never writes to another site");
});

test("the published networks are the built ones", async () => {
  const { parseHocon } = await import("../runtime/hocon.js");
  for (const [hocon, json] of [["preflight.hocon", "preflight.network.json"], ["peer/spec_helper.hocon", "peer/spec_helper.network.json"]]) {
    const source = parseHocon(await readFile(path.join(ROOT, hocon), "utf8"));
    const published = JSON.parse(await readFile(path.join(ROOT, json), "utf8"));
    assert.deepEqual(published.tools.map((t) => t.name), source.tools.map((t) => t.name), json);
    assert.equal(published.tools[0].instructions, source.tools[0].instructions, `${json} is up to date`);
  }
});
