"""Local servers for Preflight's browser tests: a static host with CORS that logs every
request, and a scripted OpenAI-compatible router that answers like a model following
Preflight's instructions. Nothing here talks to the internet."""
import json, sys
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer


class StaticHost(SimpleHTTPRequestHandler):
    """Serves files with Access-Control-Allow-Origin: *, like GitHub Pages, and logs requests."""
    log_path = None

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.log_path:
            with open(self.log_path, "a") as f:
                f.write(json.dumps({"path": self.path, "auth": self.headers.get("Authorization", ""),
                                    "cookie": self.headers.get("Cookie", "")}) + "\n")
        return super().do_GET()

    def log_message(self, *args):
        pass


def sse(handler, chunks):
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    for chunk in chunks:
        handler.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
    handler.wfile.write(b"data: [DONE]\n\n")


def say(content):
    return [{"model": "scripted-test-model", "choices": [{"delta": {"content": content}, "finish_reason": None}]},
            {"model": "scripted-test-model", "choices": [{"delta": {}, "finish_reason": "stop"}]}]


def call(name, args, n):
    return [{"model": "scripted-test-model", "choices": [{"delta": {"tool_calls": [{"index": 0, "id": f"call_{n}", "type": "function",
             "function": {"name": name, "arguments": json.dumps(args)}}]}, "finish_reason": None}]},
            {"model": "scripted-test-model", "choices": [{"delta": {}, "finish_reason": "tool_calls"}]}]


class ScriptedRouter(BaseHTTPRequestHandler):
    """Plays the model: check the site, prepare a live test, call the peer, then answer."""
    log_path = None
    target = None

    def log_message(self, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = body["messages"]
        system = messages[0]["content"] if messages and messages[0]["role"] == "system" else ""
        called = [tc["function"]["name"] for m in messages if m["role"] == "assistant" for tc in (m.get("tool_calls") or [])]
        agent = ("preflight_inspector" if "Preflight's assistant" in system
                 else "spec_helper" if "Worldwide Agentic Web MVP spec for developers" in system else "other")
        with open(self.log_path, "a") as f:
            f.write(json.dumps({"agent": agent, "auth": self.headers.get("Authorization", ""), "called": called}) + "\n")
        if agent == "preflight_inspector":
            for step, (name, args) in enumerate([("website_run_preflight", {"url": self.target}),
                                                 ("website_prepare_live_test", {}),
                                                 ("site_under_test", {"request": "What must agent-manifest.json contain?"})]):
                if name not in called:
                    return sse(self, call(name, args, step))
            last = messages[-1]["content"] if messages[-1]["role"] == "tool" else ""
            return sse(self, say("Live test done. The peer answered: " + str(last)[:200]))
        if agent == "spec_helper":
            return sse(self, say("agent-manifest.json lists each network with name, front_man and hocon, plus the LLM router and peer policy (section 3.3)."))
        return sse(self, say("ok"))


if __name__ == "__main__":
    kind, port = sys.argv[1], int(sys.argv[2])
    if kind == "static":
        StaticHost.log_path = sys.argv[4] if len(sys.argv) > 4 else None
        ThreadingHTTPServer(("127.0.0.1", port), partial(StaticHost, directory=sys.argv[3])).serve_forever()
    else:
        ScriptedRouter.log_path, ScriptedRouter.target = sys.argv[3], sys.argv[4]
        ThreadingHTTPServer(("127.0.0.1", port), ScriptedRouter).serve_forever()
