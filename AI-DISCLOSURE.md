# AI disclosure

## AI used to build Preflight

- **Claude Code** (Anthropic) was our coding assistant for the checks, the page, the agent
  networks, the tests and the demo video tooling. We (Adrian Erlikhman and Michael Tarekegn)
  chose the problem, decided what Preflight checks and what it must never do (write to another
  site, send a key anywhere but the visitor's router), and reviewed and tested what it wrote.
- The finding about page-action manifests without an action bridge comes from our own browser
  test against the reference runtime (`tests/e2e/test_browser.py`).

## AI inside Preflight

The checks use no model: the same site always gives the same report.

The assistant is optional. It runs in the visitor's browser with the visitor's own LLM router
and key, through the reference runtime from the agentic-web repository. It reads the report,
the fetched files and the bundled spec through website actions, and is told to use only what
those return. The browser, not the model, asks before any other site is contacted.
