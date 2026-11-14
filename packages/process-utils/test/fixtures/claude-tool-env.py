import http.server
import json
import os
import subprocess
import sys
import threading
import tempfile

claude, port, wrapper = sys.argv[1:]
results = []
parent_authenticated = []
names = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]
command = "python3 -c 'import os,json; print(json.dumps([k in os.environ for k in " + json.dumps(names) + "]))'"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if not self.path.split("?")[0].endswith("/messages"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")
            return
        parent_authenticated.append(self.headers.get("Authorization") == "Bearer synthetic-probe")
        tool_results = [c for m in data.get("messages", []) for c in m.get("content", []) if isinstance(c, dict) and c.get("type") == "tool_result"]
        results.extend(tool_results)
        content = {"type": "text", "text": "ok"} if tool_results else {"type": "tool_use", "id": "toolu_probe", "name": "Bash", "input": {"command": command, "description": "Report variable presence only"}}
        message = {"id": "msg_probe", "type": "message", "role": "assistant", "model": "claude-haiku-5-5", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}
        events = [("message_start", {"message": message}), ("content_block_start", {"index": 0, "content_block": content if tool_results else dict(content, input={})})]
        if not tool_results:
            events.append(("content_block_delta", {"index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(content["input"])}}))
        events += [("content_block_stop", {"index": 0}), ("message_delta", {"delta": {"stop_reason": "end_turn" if tool_results else "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 1}}), ("message_stop", {})]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for name, event in events:
            self.wfile.write(("event: " + name + "\ndata: " + json.dumps(dict(event, type=name)) + "\n\n").encode())


server = http.server.HTTPServer(("127.0.0.1", int(port)), Handler)
workspace = tempfile.TemporaryDirectory(prefix="claude-tool-env-")
threading.Thread(target=server.serve_forever, daemon=True).start()
env = {k: v for k, v in os.environ.items() if k in ["PATH", "HOME", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR"]}
env.update(ANTHROPIC_BASE_URL="http://127.0.0.1:" + port, ANTHROPIC_AUTH_TOKEN="synthetic-probe", CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST="1", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB="1")
if wrapper:
    env["CLAUDE_CODE_SHELL_PREFIX"] = wrapper
try:
    child = subprocess.run([claude, "-p", "Run the Bash tool once", "--model", "claude-haiku-5-5", "--allowedTools", "Bash", "--tools", "Bash", "--strict-mcp-config", "--setting-sources", ""], env=env, cwd=workspace.name, capture_output=True, text=True, timeout=45)
    assert child.returncode == 0, "Claude fixture failed; raw output withheld"
    assert results, "Claude did not invoke Bash"
    assert all(not r.get("is_error") for r in results), "Bash fixture failed; raw output withheld"
    observed = [json.loads(r["content"]) for r in results]
    assert all(v == [False, False, False] for v in observed), "Tool retained routing variables: " + json.dumps(observed)
    assert len(parent_authenticated) >= 2 and all(parent_authenticated), "Parent did not stay on authenticated fixture route"
    print("actual Claude Bash environment clean; parent route authenticated")
finally:
    server.shutdown()
    server.server_close()
    workspace.cleanup()
