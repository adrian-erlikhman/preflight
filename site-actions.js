// Registers Preflight's operations with the browser runtime. agent-manifest.json loads
// this module through "actions.module"; the names in "actions.agentTools" become model
// tools called website_<name>. Each action wraps the page object the page's own
// buttons use (js/app.js), so the assistant and the page follow the same rules.
import { App } from "./js/app.js";
import { SPEC_SECTIONS } from "./js/spec.js";

class SiteActions {
  static registerActions(actions) {
    actions.register(SiteActions.runPreflight());
    actions.register(SiteActions.getReport());
    actions.register(SiteActions.getFile());
    actions.register(SiteActions.getSpecSection());
    actions.register(SiteActions.prepareLiveTest());
  }

  static runPreflight() {
    return {
      name: "run_preflight",
      description: "Check an agentic website against the MVP spec and show the report on the page, replacing the current one. Asks the visitor before contacting a site they have not approved. Returns verdicts, failed and warning checks with fixes, and the networks found. Changes nothing on the checked site.",
      // It replaces the report panel, which the visitor can undo by checking again.
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", minLength: 4, maxLength: 500, description: "The site URL the visitor gave: a site base, a page, its agent-manifest.json, or a peer-network URL ending in the network name." },
          check_peers: { type: "boolean", description: "Also check that linked peer networks are published. Only when the visitor asks." },
        },
      },
      execute: (args) => App.page.runCheck(args.url, { deep: !!args.check_peers }),
    };
  }

  static getReport() {
    return {
      name: "get_report",
      description: "Read the report shown on the page: verdicts, every failed or warning check with its detail, evidence and fix, passed check titles, networks, sample queries and files read.",
      effect: "read",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      execute: () => App.page.getReport(),
    };
  }

  static getFile() {
    return {
      name: "get_file",
      description: "Read the text of a public file from the current report, to write a corrected version. Returns the text exactly as the site published it.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["role"],
        properties: {
          role: { type: "string", enum: ["manifest", "network", "links"], description: "manifest is agent-manifest.json, network is a network definition, links is links.json." },
          network: { type: "string", maxLength: 120, description: "For role network: the network name from the report, when there are several." },
        },
      },
      execute: (args) => App.page.getFile(args),
    };
  }

  static getSpecSection() {
    return {
      name: "get_spec_section",
      description: "Read one section of the Worldwide Agentic Web MVP spec (profile 0.2) word for word, to quote it. Each check in the report names its section.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["section"],
        properties: {
          section: { type: "string", enum: SPEC_SECTIONS, description: "Section number, such as 3.2." },
        },
      },
      execute: (args) => App.page.getSpecSection(args),
    };
  }

  static prepareLiveTest() {
    return {
      name: "prepare_live_test",
      description: "Point the site_under_test link at the network in the current report, so the next site_under_test call loads it as a peer and runs it in this browser. Refuses when a runtime could not load it. Returns the target URL and the network's sample queries.",
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          network: { type: "string", maxLength: 120, description: "The network name from the report, when there are several." },
        },
      },
      execute: (args) => App.page.prepareLiveTest(args),
    };
  }
}

export function registerActions(actions) {
  SiteActions.registerActions(actions);
}
