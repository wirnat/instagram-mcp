"""Debug: run one GraphQL query through the server and print the shape of the response (long values truncated).

Usage: python3 scripts/try.py <QueryName> '<json variables>' [depth] [dotted.path]
The full response is saved to .probe/q-<QueryName>.json. Requires a running server with INSTAGRAM_MCP_DEBUG=1.
"""
import json
import subprocess
import sys

name, variables = sys.argv[1], sys.argv[2]
maxd = int(sys.argv[3]) if len(sys.argv) > 3 else 3
path = sys.argv[4].split(".") if len(sys.argv) > 4 else []

method = "GQL"
if name in ("GET", "POST"):
    method, name = name, sys.argv[2]
    variables = sys.argv[3] if len(sys.argv) > 3 else "{}"
    maxd = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    path = sys.argv[5].split(".") if len(sys.argv) > 5 else []

out = subprocess.run(["node", "dist/index.js", "raw", method, name, variables, "50000000"], capture_output=True, text=True).stdout
safe = name.strip("/").replace("/", "_")[:60]
open(".probe/q-%s.json" % safe, "w").write(out)
d = json.loads(out)


def shape(o, depth):
    if isinstance(o, dict):
        if depth >= maxd:
            return "{…%d}" % len(o)
        return {k: shape(v, depth + 1) for k, v in list(o.items())[:70]}
    if isinstance(o, list):
        return [shape(o[0], depth + 1), "×%d" % len(o)] if o else []
    return (o[:40] + "…") if isinstance(o, str) and len(o) > 40 else o


if isinstance(d, dict) and "error" in d and len(d) == 1:
    print("ERROR", json.dumps(d["error"])[:700])
    sys.exit(1)
if isinstance(d, dict) and d.get("errors"):
    print("GQL ERRORS", json.dumps(d["errors"])[:500])
o = d.get("data", d) if isinstance(d, dict) and method == "GQL" else d
for p in path:
    o = o[int(p)] if isinstance(o, list) else o[p]
print(json.dumps(shape(o, 0), ensure_ascii=False, indent=1)[:5000])
