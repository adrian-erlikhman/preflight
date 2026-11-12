// app.js — Preflight's page: the check form, the report, exports and live-test wiring.
//
// The page object (App.page) is shared by the page's own buttons and by the assistant's
// website_* actions (site-actions.js), so both follow the same rules.

import { runPreflight, parseTarget, originOf, GROUPS, SECTIONS, PROFILE, sectionUrl } from "./checks.js";
import { toMarkdown, compactReport, badgeFor, fileResult } from "./export.js";
import { specSection } from "./spec.js";

const SITE_BASE = new URL("../", import.meta.url).href;
const STATUS_LABEL = { pass: "Pass", fail: "Fail", warn: "Review", info: "Note", skip: "Skipped" };
const LEVEL_LABEL = { must: "Required", should: "Recommended", info: "" };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * The page state and operations.
 */
class PreflightPage {
  constructor() {
    this.report = null;
    this.texts = new Map();
    this.approved = new Set(typeof location !== "undefined" ? [location.origin] : []);
    this.running = null;
    this.engine = null;
    this.version = 0;
  }

  // --- Operations shared by the page and the assistant -------------------------------

  /**
   * Check a site and show the report.
   *
   * :param url: The site URL.
   * :param options: {deep, fromVisitor}. A URL the visitor typed and submitted counts as
   *   their approval to read that origin's public files.
   * :return: The compact report, or {ok: false, reason}.
   */
  async runCheck(url, { deep = false, fromVisitor = false } = {}) {
    const target = parseTarget(url);
    if (!target.ok) return { ok: false, reason: target.reason };
    if (this.running) return { ok: false, reason: "A check is already running. Wait for it to finish." };
    if (fromVisitor) this.approved.add(originOf(target.url));
    this.texts = new Map();
    const texts = this.texts;
    const fetchImpl = async (input, init = {}) => {
      const response = await fetch(input, init);
      if (init.mode === "no-cors") return response;
      return {
        ok: response.ok, status: response.status, url: response.url, headers: response.headers,
        text: async () => {
          const text = await response.text();
          texts.set(String(input), text);
          return text;
        },
      };
    };
    this.showRunning(target.url);
    this.running = runPreflight(target.url, {
      fetch: fetchImpl,
      approved: this.approved,
      approve: (origin, purpose) => this.askToContact(origin, purpose),
      deep,
    });
    try {
      this.report = await this.running;
    } catch (error) {
      this.showError(`The check stopped: ${error.message}`);
      return { ok: false, reason: `The check stopped unexpectedly: ${error.message}` };
    } finally {
      this.running = null;
    }
    this.version += 1;
    this.render();
    this.setUrlParam(target.url);
    return compactReport(this.report);
  }

  getReport() {
    return compactReport(this.report);
  }

  /**
   * The text of a public file Preflight read in the current report.
   *
   * :param role: "manifest", "network" or "links".
   * :param network: For role "network", which network's file.
   */
  getFile({ role, network }) {
    if (!this.report) return { ok: false, reason: "No site has been checked yet." };
    let url;
    if (role === "manifest") url = `${this.report.base}/agent-manifest.json`;
    else if (role === "links") url = `${this.report.base}/links.json`;
    else {
      const entry = this.report.networks.find((n) => !network || n.name === network);
      url = entry?.hocon;
    }
    const text = url ? this.texts.get(url) : undefined;
    if (text === undefined) return { ok: false, reason: `Preflight did not read a ${role} file${network ? ` for ${network}` : ""} in this check.` };
    const limit = 24000;
    return { ok: true, url, truncated: text.length > limit, text: text.length > limit ? text.slice(0, limit) : text };
  }

  async getSpecSection({ section }) {
    return specSection(section, fetch, SITE_BASE);
  }

  /**
   * Point the assistant's site_under_test link at the checked network, so its next call
   * loads that network as a peer and runs it in this browser.
   *
   * :param network: The network name, when the report has several.
   */
  prepareLiveTest({ network } = {}) {
    const report = this.report;
    if (!report) return { ok: false, reason: "Check a site first. The live test runs the network from the current report." };
    const entry = report.networks.find((n) => !network || n.name === network);
    if (!entry) return { ok: false, reason: `The report has no network named ${network}. It has ${report.networks.map((n) => n.name).join(", ") || "none"}.` };
    const blocker = this.liveTestBlocker(entry.name);
    if (blocker) return { ok: false, reason: blocker };
    if (!this.engine) return { ok: false, reason: "The assistant is not connected on this page." };
    const target = `${report.base}/${entry.name}`;
    this.engine.top.network.setLink("site_under_test", target);
    return {
      ok: true,
      target,
      network: entry.name,
      front_agent: entry.front_man,
      sample_queries: entry.sampleQueries.slice(0, 4),
      note: "Call site_under_test with one short request. The browser asks the developer before it contacts the site.",
    };
  }

  /**
   * Why a live test of a network in the current report cannot run, or "" when it can.
   */
  liveTestBlocker(networkName) {
    const report = this.report;
    if (!report || !report.networks.length) return "No network was found to test.";
    const name = networkName || report.networks[0].name;
    const blocking = report.checks.find((c) => c.status === "fail" && (!c.network || c.network === name)
      && ["manifest.fetch", "manifest.json", "network.fetch", "network.json", "network.shape", "manifest.exact_match", "network.data_only"].includes(c.id));
    if (blocking) return `A runtime cannot load it yet: "${blocking.title}" failed. ${blocking.detail}`;
    const bridge = report.checks.find((c) => c.id === "portable.action_bridge" && c.status !== "pass");
    if (bridge) return `${bridge.detail} Preflight skips the live test so it does not open that window.`;
    return "";
  }

  // --- Consent before contacting another origin (spec 5) -----------------------------

  askToContact(origin, purpose) {
    return new Promise((resolve) => {
      const dialog = el("dialog", { class: "consent", "aria-labelledby": "consent-title" },
        el("h2", { id: "consent-title", tabindex: "-1", text: `Read public files from ${origin}?` }),
        el("p", { text: `Preflight wants to ${purpose}. It sends a plain GET with no cookies or keys, and reads only what the site publishes for every visitor.` }),
        el("div", { class: "consent-actions" },
          el("button", { class: "button primary", value: "allow", text: "Read the files" }),
          el("button", { class: "button", value: "decline", text: "Don't contact it" })));
      for (const button of dialog.querySelectorAll("button")) {
        button.addEventListener("click", () => dialog.close(button.value));
      }
      dialog.addEventListener("close", () => {
        dialog.remove();
        resolve(dialog.returnValue === "allow");
      });
      document.body.append(dialog);
      dialog.showModal();
      dialog.querySelector("h2").focus();
    });
  }

  // --- Rendering -------------------------------------------------------------------

  showRunning(url) {
    const status = document.querySelector("#check-status");
    status.textContent = `Checking ${url}…`;
    document.querySelector("#run").disabled = true;
    document.querySelector("#report").setAttribute("aria-busy", "true");
  }

  showError(message) {
    document.querySelector("#check-status").textContent = message;
    document.querySelector("#run").disabled = false;
    document.querySelector("#report").removeAttribute("aria-busy");
  }

  render() {
    const report = this.report;
    const root = document.querySelector("#report");
    root.removeAttribute("aria-busy");
    root.hidden = false;
    document.querySelector("#run").disabled = false;
    const s = report.summary;
    const readAnything = report.files.some((f) => f.role === "manifest");
    document.querySelector("#check-status").textContent = !readAnything
      ? `Nothing was checked: you declined to contact ${report.declined.join(", ") || "the site"}.`
      : s.must.fail
        ? `${s.must.fail} required check${s.must.fail === 1 ? "" : "s"} failed.`
        : "All required checks passed.";

    const head = root.querySelector("#report-head");
    head.replaceChildren(
      el("p", { class: "eyebrow", text: `Report · ${PROFILE.name} ${PROFILE.version}` }),
      el("h2", { id: "report-title", text: report.base || report.target }),
      el("p", { class: "report-meta" },
        report.networks.length ? `Network${report.networks.length > 1 ? "s" : ""}: ${report.networks.map((n) => n.name).join(", ")} · ` : "",
        `read as a ${report.interpretation || "site URL"} · ${new Date(report.finishedAt).toLocaleString()}`),
    );

    const verdicts = root.querySelector("#verdicts");
    verdicts.replaceChildren(...Object.values(s.verdicts).map((v) =>
      el("li", { class: `verdict ${v.ok ? "ok" : "no"}` },
        el("span", { class: "verdict-mark", "aria-hidden": "true", text: v.ok ? "✓" : "✕" }),
        el("span", { text: v.label }),
        el("span", { class: "visually-hidden", text: v.ok ? ": yes" : ": not yet" }))));

    root.querySelector("#counts").replaceChildren(
      count("Required", s.must.pass, s.must.fail, "failed", "fail"),
      count("Recommended", s.should.pass, s.should.warn, "to review", "warn"),
    );

    const groups = root.querySelector("#groups");
    groups.replaceChildren(...GROUPS.map((group) => this.renderGroup(group, report)).filter(Boolean));

    const files = root.querySelector("#files tbody");
    files.replaceChildren(...report.files.map((f) =>
      el("tr", {},
        el("td", { text: f.role }),
        el("td", {}, el("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", class: "mono", text: shortUrl(f.url, report.base) })),
        el("td", { class: f.ok ? "ok" : (f.role === "discovery" || f.role === "links") && f.status === 404 ? "" : "bad", text: f.role === "discovery" && f.status === 404 ? "not published (optional)" : fileResult(f) }),
        el("td", { class: "num", text: `${f.ms} ms` }))));

    const live = root.querySelector("#live-test");
    const blocker = this.liveTestBlocker();
    live.disabled = !!blocker;
    live.title = blocker || "Ask the assistant to load this network as a peer and send it a question.";
    root.querySelector("#live-note").textContent = blocker ? `Live test unavailable. ${blocker}` : "Uses the assistant below, with your LLM key. The browser asks before contacting the site.";
    document.querySelector("#report-title").focus?.();
  }

  renderGroup(group, report) {
    const checks = report.checks.filter((c) => c.group === group.id);
    if (!checks.length) return null;
    const problems = checks.filter((c) => c.status === "fail" || c.status === "warn");
    const rest = checks.filter((c) => !problems.includes(c));
    const section = el("section", { class: "group", "aria-labelledby": `group-${group.id}` },
      el("h3", { id: `group-${group.id}` }, group.title,
        el("span", { class: "group-count", text: problems.length ? `${problems.length} to fix` : "all clear" })));
    const list = el("ul", { class: "checks" }, problems.map((c) => this.renderCheck(c)));
    section.append(list);
    if (rest.length) {
      const more = el("details", { class: "passed" },
        el("summary", { text: `${rest.length} passed or noted` }),
        el("ul", { class: "checks" }, rest.map((c) => this.renderCheck(c))));
      if (!problems.length) more.open = group.id !== "discovery" && group.id !== "challenge";
      section.append(more);
    }
    return section;
  }

  renderCheck(c) {
    const sectionInfo = SECTIONS[c.section];
    const item = el("li", { class: `check ${c.status}` },
      el("div", { class: "check-head" },
        el("span", { class: `pill ${c.status}`, text: STATUS_LABEL[c.status] }),
        el("span", { class: "check-title", text: c.title }),
        c.network ? el("span", { class: "tag mono", text: c.network }) : null,
        LEVEL_LABEL[c.level] ? el("span", { class: "level", text: LEVEL_LABEL[c.level] }) : null,
        sectionInfo && c.section !== "challenge"
          ? el("a", { class: "section-link", href: sectionUrl(c.section), target: "_blank", rel: "noopener noreferrer", title: `Spec section ${c.section}: ${sectionInfo.title}`, text: `§${c.section}` })
          : null),
      el("p", { class: "check-detail", text: c.detail }));
    if (c.evidence?.length) {
      item.append(el("ul", { class: "evidence" }, c.evidence.slice(0, 12).map((e) => el("li", { class: "mono", text: e }))));
    }
    if (c.fix && c.status !== "pass") item.append(el("p", { class: "check-fix" }, el("strong", { text: "Fix: " }), c.fix));
    return item;
  }

  setUrlParam(url) {
    try {
      const params = new URLSearchParams(location.search);
      params.set("url", url);
      history.replaceState(null, "", `${location.pathname}?${params}`);
    } catch {}
  }

  // --- Exports ---------------------------------------------------------------------

  async copyMarkdown() {
    await navigator.clipboard.writeText(toMarkdown(this.report, pageUrl()));
    return "Markdown report copied.";
  }

  downloadJson() {
    const blob = new Blob([JSON.stringify(this.report, null, 2)], { type: "application/json" });
    const link = el("a", { href: URL.createObjectURL(blob), download: `preflight-${hostSlug(this.report.base)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    return "JSON report downloaded.";
  }

  async copyBadge() {
    const badge = badgeFor(this.report, pageUrl());
    await navigator.clipboard.writeText(badge.markdown);
    return `Badge copied: “preflight | ${badge.message}”.`;
  }
}

function count(label, passed, problems, problemWord, tone) {
  return el("div", { class: "count" },
    el("span", { class: "count-label", text: label }),
    el("span", { class: "count-values" },
      el("span", { class: "count-pass", text: `${passed} passed` }),
      problems ? el("span", { class: `count-problem ${tone}`, text: `${problems} ${problemWord}` }) : null));
}

function shortUrl(url, base) {
  if (base && url.startsWith(`${base}/`)) return url.slice(base.length + 1) || "/";
  if (base && url === `${base}/`) return "/ (site page)";
  return url.replace(/^https?:\/\//, "");
}

function hostSlug(base) {
  try { return new URL(base).host.replace(/[^a-z0-9]+/gi, "-"); } catch { return "site"; }
}

function pageUrl() {
  return `${location.origin}${location.pathname}`;
}

export class App {
  static page = new PreflightPage();
}

// --- Wiring the page's own controls ---------------------------------------------------

if (typeof window !== "undefined") {
  const page = App.page;
  const form = document.querySelector("#check-form");
  const input = document.querySelector("#site-url");
  const deep = document.querySelector("#deep");
  const toast = document.querySelector("#toast");
  const say = (text) => { toast.textContent = text; };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    page.runCheck(input.value, { deep: deep.checked, fromVisitor: true }).then((result) => {
      if (result && result.ok === false) {
        input.setCustomValidity(result.reason);
        input.reportValidity();
        document.querySelector("#check-status").textContent = result.reason;
      }
    });
  });
  input.addEventListener("input", () => input.setCustomValidity(""));

  for (const button of document.querySelectorAll("[data-example]")) {
    button.addEventListener("click", () => {
      input.value = new URL(button.dataset.example, SITE_BASE).href;
      form.requestSubmit();
    });
  }

  document.querySelector("#copy-md").addEventListener("click", () => page.copyMarkdown().then(say, () => say("Could not copy. Your browser blocked the clipboard.")));
  document.querySelector("#download-json").addEventListener("click", () => say(page.downloadJson()));
  document.querySelector("#copy-badge").addEventListener("click", () => page.copyBadge().then(say, () => say("Could not copy. Your browser blocked the clipboard.")));
  document.querySelector("#live-test").addEventListener("click", () => {
    const chat = document.querySelector("#ns-input");
    const send = document.querySelector("#ns-send");
    const networks = page.report?.networks || [];
    if (!chat || !send) {
      say("The assistant is not loaded on this page.");
      return;
    }
    chat.value = `Run a live test: load ${networks[0]?.name || "the checked network"} as a peer and ask it one of its sample questions.`;
    document.querySelector("#assistant").scrollIntoView({ behavior: "smooth", block: "start" });
    send.click();
  });

  // ?url= fills the form. The visitor still presses Run, so a link never makes this
  // page contact another site by itself.
  const fromLink = new URLSearchParams(location.search).get("url");
  if (fromLink) {
    input.value = fromLink;
    document.querySelector("#check-status").textContent = "Press Run preflight to check this site.";
  }
}
