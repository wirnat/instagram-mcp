"""Debug: summarize the shape of GraphQL responses from a `probe` dump.

Usage: python3 scripts/shape.py <file.json> [query-name] [depth] [dotted.path]
Without a query name it lists the captured queries and their variables.
"""
import json
import sys


def shape(o, depth, maxd):
    if isinstance(o, dict):
        if depth >= maxd:
            return "{…%d}" % len(o)
        return {k: shape(v, depth + 1, maxd) for k, v in list(o.items())[:80]}
    if isinstance(o, list):
        return [shape(o[0], depth + 1, maxd), "×%d" % len(o)] if o else []
    return o[:60] if isinstance(o, str) else o


d = json.load(open(sys.argv[1]))
name = sys.argv[2] if len(sys.argv) > 2 else None
maxd = int(sys.argv[3]) if len(sys.argv) > 3 else 3
path = sys.argv[4].split(".") if len(sys.argv) > 4 else []

if not name:
    print("finalUrl:", d.get("finalUrl"))
    for q in d.get("queries", []):
        print(q["name"], q["docId"], json.dumps(q["variables"], ensure_ascii=False)[:300])
    print("--- responses")
    for r in d.get("responses", []):
        print(r["name"], r["keys"])
    sys.exit()

for q in d.get("queries", []):
    if q["name"] == name:
        print("VARIABLES", json.dumps(q["variables"], ensure_ascii=False))
        break
for r in d.get("responses", []):
    if r["name"] == name and "data" in r:
        o = r["data"]
        for p in path:
            o = o[int(p)] if isinstance(o, list) else o[p]
        print(json.dumps(shape(o, 0, maxd), ensure_ascii=False, indent=1)[:9000])
        break
else:
    print("no response for", name, "in this file (run probe with the dump argument)")
