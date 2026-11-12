# Preflight

**Will other sites be able to run your agents?** Preflight checks an open agentic website
against the [Worldwide Agentic Web MVP spec](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md)
(profile 0.2), from a different origin, the way a peer site's browser will load it. Its
assistant then explains each failure, writes the corrected file, and can load your network
as a peer and run it in your browser.

- **Live:** https://adrian-erlikhman.github.io/preflight/
- **Portable network for other sites:** `https://adrian-erlikhman.github.io/preflight/peer/spec_helper`

Preflight is itself an open agentic website: a published two-agent network, run by the
reference browser runtime, with BYOK settings and five website actions.

## Why

An agentic website is only part of the agentic web if another site can load it. That depends
on details you cannot see from your own origin: CORS on the manifest and network file, a
`front_man` that matches the agent the runtime actually starts from, peer URLs that end in a
network name, a peer policy that allows the peers you reference, private-context rules,
and no keys in published files. When we loaded the agentic-web repository's pizza example
from a second origin, the reference runtime would not load it: its manifest declares page
actions but no action bridge, so the runtime waits about 10 seconds, then asks the visitor to
open a window on the other site. Preflight finds these problems before other sites do.

## What it checks

Every check names the spec section it comes from. Required checks follow the spec's MUST;
recommended checks follow SHOULD.

| Area | Checks |
| --- | --- |
| Public files (§3.3, §3.4) | HTTPS; `agent-manifest.json` readable cross-origin with no cookies; a missing CORS header told apart from a missing file or an unreachable host; valid JSON; networks with `name`, `front_man` and `hocon`; unique names; peer policy; exact network-name match for a peer URL (§3.2); `links.json` bindings |
| Network definition (§2.1, §2.2, §3.1) | network file readable cross-origin; published as resolved JSON; data only (no includes, substitutions or local paths); parsed and validated with the **reference runtime's own code**; duplicate agent names; front agent matches the manifest; descriptions, instructions and tools lists; JSON Schema inputs on every called agent; coded-tool bundles and SRI; instructions that tell the model to invent results |
| Peers, tools, private context (§2.1, §3.2, §5) | peer URLs are HTTPS and end in a network name; your own peer policy allows them; optionally, each peer actually publishes that network; MCP descriptors; link slots; `sly_data` allow rules name fields instead of `*` |
| Inference and credentials (§4) | an LLM router is declared and uses HTTPS; no API keys, tokens or passwords in any published file (masked in the report) |
| Loading as a peer (§3.2) | no dependence on page-local `website_*` actions; no action-bridge prompt for callers; model settings are hints |
| Challenge checklist | public page, `.json` network, a runtime on the page, optional BYOK |

Four verdicts summarize the report: publishes a valid network, readable from other origins,
runs when another site loads it, and no credentials in public files.

## The assistant

The `preflight` network has two agents and a named peer link:

- `preflight_inspector` (front agent) runs checks, reads the report and the fetched files,
  quotes the spec, and runs live tests.
- `fix_writer` writes the corrected `agent-manifest.json`, network file or `links.json`.
- `site_under_test` is a link slot. Before a live test, the page binds it to the checked
  network; the runtime asks the visitor, loads that network as a peer, and runs it with the
  visitor's router and key.

Website actions (`site-actions.js`): `run_preflight`, `get_report`, `get_file`,
`get_spec_section` (the bundled spec, word for word) and `prepare_live_test`. None of them
writes to another site.

The second network, `spec_helper` in `peer/`, has no website actions, so other agentic
websites can load it as a peer. It answers spec questions and drafts the files the spec
requires.

## How it meets the MVP interoperability checks (§6)

| Check | How Preflight shows it |
| --- | --- |
| Publish a two-agent network and a manifest over HTTPS | `preflight` and `spec_helper`, each two agents, on GitHub Pages |
| Run it in a browser with the default router; BYOK if offered | Hosted Otari by default; any OpenAI-compatible router or Anthropic with the visitor's key |
| Call an internal agent and a grounded capability | `fix_writer`; five registered site actions |
| Load an exact named network from a second origin after approval | Live test via `site_under_test`; tested from `localhost` to `127.0.0.1` |
| The second site never receives the key and cannot change the router | Browser test logs every request to the peer origin: none carries a key or cookies |
| Private context absent at the peer unless allowed | No allow rules: deny by default |
| Stop invalid networks, cycles, over-budget requests and denied origins | The reference runtime does; the browser test shows an invalid peer and a wrong name stopped with visible errors |

## Run it locally

```shell
python3 -m http.server 8080 --bind 127.0.0.1
# open http://127.0.0.1:8080/
```

The checks need no key. The assistant needs an LLM key in **BYOK / router settings**.

## Tests

```shell
node --test "tests/*.test.mjs"          # 15 tests: checks, exports, spec, actions, builds
python3 tests/e2e/test_browser.py       # 12 Chromium checks on two local origins
```

The browser tests run Preflight and a second site on two local origins, with a scripted
OpenAI-compatible router that logs every request. They check both consent prompts, the
live peer run, that the key reaches only the router, and that invalid networks, wrong names
and page-action manifests fail the way Preflight reports.

`fixtures/common-mistakes/` is a deliberately broken sample site; its README lists each
mistake and the check that catches it.

## Build the networks

The `.hocon` files are the source. Rebuild the published JSON and discovery files with the
agentic-web repository's build script:

```shell
npm run build
```

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `css/`, `js/app.js` | The page |
| `js/checks.js` | The checks (no model involved) |
| `js/export.js`, `js/spec.js` | Markdown, JSON and badge exports; spec sections |
| `site.js`, `site-actions.js` | Mounts the runtime; registers the website actions |
| `preflight.hocon` → `preflight.network.json` | The main network |
| `peer/` | The portable `spec_helper` network |
| `agent-manifest.json`, `links.json`, `agent-mcp.json`, `.well-known/` | Public agent files |
| `runtime/` | The reference browser runtime, unchanged, from the agentic-web repository |
| `spec/` | A copy of the MVP spec (profile 0.2) the assistant quotes |
| `fixtures/common-mistakes/` | A broken sample site |
| `tests/` | Node tests and browser tests |

## Limits

Preflight sees what a published site shows from the outside. It cannot see server code,
response headers the browser hides, or how a runtime behaves under load. Its assistant
cannot change or deploy another site, and it cannot run another site's page-local actions.
Its main network relies on its own page actions, so it reports a warning on itself; the
`peer/spec_helper` network is the one meant for other sites.

## Credits

By Adrian Erlikhman and Michael Tarekegn for the Open Agentic Web Challenge.
The browser runtime, the network build script and the spec copy are from
[cognizant-ai-labs/agentic-web](https://github.com/cognizant-ai-labs/agentic-web) (Apache 2.0).
See [AI-DISCLOSURE.md](AI-DISCLOSURE.md) for how AI was used. MIT licensed.
