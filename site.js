// Mounts the Preflight assistant: the reference browser runtime, pointed at this folder,
// so the manifest, network and website actions load from the same place as the page.
// Adapted from the agentic-web repository's skills/agentify-website/templates/site.js.
import { App } from "./js/app.js";

export class AssistantMount {
  static GREETING = "I can check an agentic website against the MVP spec, explain what failed and why it matters, write corrected files, and load the checked network as a peer to test it live. Paste a site URL or ask about the report above.";

  // Preflight has no irreversible actions: it never writes to another site.
  static DIALOGS = {};

  static async start() {
    const status = document.querySelector("#assistant-status");
    const siteBase = new URL("./", import.meta.url).href;
    try {
      const { boot } = await import("./runtime/index.js");
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
      });
      AssistantMount.engine = booted.engine;
      App.page.engine = booted.engine;
      const needsKey = !booted.engine.mockLLM
        && (!booted.engine.byokKey || booted.engine.byokKey === "demo");
      status.textContent = needsKey
        ? "The assistant needs your LLM key: open BYOK / router settings below. The checks above work without one."
        : "Assistant connected. It can read the report on this page.";
      if (!needsKey) AssistantMount.greet();
      return booted.engine;
    } catch (error) {
      status.textContent = "The assistant could not load. The checks above still work.";
      console.error("Assistant startup failed", error);
      return null;
    }
  }

  static greet() {
    const first = document.querySelector("#ns-msgs .ns-msg.bot");
    if (first) first.textContent = AssistantMount.GREETING;
  }
}

if (typeof window !== "undefined") {
  await AssistantMount.start();
}
