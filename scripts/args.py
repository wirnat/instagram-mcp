"""Debug: print the variable names and root fields of a GraphQL query, read from Instagram's JavaScript bundles.

Usage: python3 scripts/args.py <QueryName> [QueryName...]
Requires a running server with INSTAGRAM_MCP_DEBUG=1.
"""
import json
import re
import subprocess
import sys

for name in sys.argv[1:]:
    out = subprocess.run(
        ["node", "dist/index.js", "raw", "SRC", '__d\\("%s\\.graphql"' % name, '{"after":6000,"max":1}', "20000"],
        capture_output=True, text=True,
    ).stdout
    try:
        src = json.loads(out)[0]
    except Exception:
        print(name, "-> not found")
        continue
    args = re.findall(r'defaultValue:([^,]+),kind:"LocalArgument",name:"([^"]+)"', src)
    roots = re.findall(r'kind:"LinkedField",name:"([a-z_0-9]+)"', src)[:3]
    obj = re.findall(r'kind:"ObjectValue",name:"([^"]+)"', src)
    literals = re.findall(r'kind:"Literal",name:"([^"]+)",value:([^}]+)\}', src)[:8]
    print(name)
    print("  vars:", ", ".join("%s=%s" % (n, d) if d != "null" else n for d, n in args))
    print("  root:", roots, "| object args:", sorted(set(obj)), "| literal:", literals)
