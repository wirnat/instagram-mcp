"""Debug: call one tool through the server and print a one-line summary.

Usage: python3 scripts/call.py <tool> ['<json args>'] [key,key,...]
Lists in the response are reduced to their length and long strings are truncated.
"""
import json
import subprocess
import sys

tool = sys.argv[1]
args = sys.argv[2] if len(sys.argv) > 2 else "{}"
keys = sys.argv[3].split(",") if len(sys.argv) > 3 else None

out = subprocess.run(["node", "dist/index.js", "call", tool, args], capture_output=True, text=True).stdout
try:
    d = json.loads(out)
except Exception:
    print(tool, "-> not JSON:", out[:300])
    sys.exit(1)


def brief(v):
    if isinstance(v, list):
        return "[%d]" % len(v)
    if isinstance(v, dict):
        return {k: brief(x) for k, x in list(v.items())[:12]}
    if isinstance(v, str) and len(v) > 70:
        return v[:70] + "…"
    return v


if isinstance(d, dict):
    if keys:
        d = {k: d.get(k) for k in keys}
    print(tool, "->", json.dumps({k: brief(v) for k, v in d.items()}, ensure_ascii=False))
else:
    print(tool, "->", brief(d))
