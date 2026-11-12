"""Browser tests for Preflight and the MVP interoperability checks it relies on.

Runs Chromium against two local origins (127.0.0.1:8090 is Preflight, localhost:8091 is a
second site) and a scripted router on 127.0.0.1:8092. Run from the repository root:

    pip install playwright && playwright install chromium
    python3 tests/e2e/test_browser.py
"""
import asyncio, json, os, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = "http://127.0.0.1:8090/"
PEER = "http://localhost:8091/peer/spec_helper"
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f": {detail}" if detail else ""))


async def main():
    tmp = tempfile.mkdtemp()
    router_log, peer_log = os.path.join(tmp, "router.jsonl"), os.path.join(tmp, "peer.jsonl")
    open(router_log, "w").close(); open(peer_log, "w").close()
    servers = [subprocess.Popen([sys.executable, os.path.join(HERE, "servers.py"), *args]) for args in (
        ["static", "8090", ROOT], ["static", "8091", ROOT, peer_log], ["router", "8092", router_log, PEER])]
    time.sleep(1.2)
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch()

            # 1. The assistant checks a second-origin site, loads its network as a peer
            #    after consent, and runs it with the caller's router and key.
            ctx = await browser.new_context()
            await ctx.add_init_script("""sessionStorage.setItem('nsweb-byok-tab-key','test-key-123');
                sessionStorage.setItem('nsweb-byok-router','http://127.0.0.1:8092/v1');
                sessionStorage.setItem('nsweb-byok-model','scripted-test-model');""")
            page = await ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.goto(SITE, wait_until="networkidle")
            await page.wait_for_function("window.__nsweb?.engine?.top", timeout=15000)
            await page.fill("#ns-input", f"Check {PEER} and run it live as a peer.")
            await page.click("#ns-send")
            await page.wait_for_selector("dialog.consent", timeout=15000)
            check("Preflight asks before reading another origin's files", "localhost:8091" in await page.inner_text("dialog.consent h2"))
            await page.click("dialog.consent button[value=allow]")
            await page.wait_for_selector(".ns-consent .ns-consent-actions button[data-d=allow]", timeout=20000)
            check("the runtime asks before loading the peer network", "localhost:8091" in await page.inner_text(".ns-consent"))
            await page.click(".ns-consent .ns-consent-actions button[data-d=allow]")
            await page.wait_for_function("[...document.querySelectorAll('#ns-msgs .ns-msg.bot')].some(m => m.innerText.includes('Live test done'))", timeout=30000)
            check("the peer network ran in this browser and answered", True)
            check("the report for the peer is on the page", "localhost:8091/peer" in await page.inner_text("#report-title"))
            log = [json.loads(line) for line in open(router_log)]
            check("the peer's agent ran on the caller's router", any(e["agent"] == "spec_helper" for e in log))
            check("every model call carried the visitor's key, to the router only", all(e["auth"] == "Bearer test-key-123" for e in log))
            peer = [json.loads(line) for line in open(peer_log)]
            check("the peer site never received the key or cookies", peer and not any(e["auth"] or e["cookie"] for e in peer), f"{len(peer)} requests to the peer origin")
            check("no page errors", not errors, "; ".join(errors[:3]))
            await ctx.close()

            # 2. Loading peers directly through the runtime, as any caller would.
            ctx = await browser.new_context()
            page = await ctx.new_page()
            await page.goto(SITE, wait_until="networkidle")
            await page.wait_for_function("window.__nsweb?.engine?.top", timeout=15000)
            load = """async (url) => {
                const start = Date.now();
                const run = window.__nsweb.engine.resolveRemote(url, [], null).then(s => 'loaded ' + s.network.name, e => 'error: ' + e.message);
                const out = await Promise.race([run, new Promise(r => setTimeout(() => r('waiting'), 15000))]);
                return {out, ms: Date.now() - start, dialog: [...document.querySelectorAll('dialog')].map(d => d.innerText).join(' ')};
            }"""
            r = await page.evaluate(load, PEER)
            check("a portable network loads from a second origin", r["out"] == "loaded spec_helper", f"{r['ms']} ms")
            r = await page.evaluate(load, "http://localhost:8091/peer/spec_helpers")
            check("a wrong network name fails instead of running another network", "No published network named" in r["out"], r["out"][:120])
            r = await page.evaluate(load, "http://localhost:8091/fixtures/common-mistakes/bike_desk")
            check("an invalid network is stopped before any model call", r["out"].startswith("error"), r["out"][:140])
            r = await page.evaluate(load, "http://localhost:8091/preflight")
            check("a network whose manifest has page actions but no bridge does not load (Preflight warns about this)",
                  r["out"] == "waiting" and "authorize this action" in r["dialog"], f"after {r['ms']} ms: {r['dialog'][:90]}")
            await ctx.close()
            await browser.close()
    finally:
        for server in servers:
            server.terminate()
    print(f"\n{sum(results)} of {len(results)} browser checks passed")
    sys.exit(0 if all(results) else 1)


asyncio.run(main())
