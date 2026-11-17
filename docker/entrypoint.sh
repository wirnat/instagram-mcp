#!/bin/sh
# Starts a virtual display, then either the MCP server or the login window.
set -e

rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp &
sleep 1

# Chromium leaves lock files behind if the previous process died. It refuses to start until they are removed.
rm -f /data/profile/SingletonLock /data/profile/SingletonCookie /data/profile/SingletonSocket

case "$1" in
  login)
    # The Chromium window is visible at http://localhost:6080/vnc.html through an SSH tunnel.
    # -clear_all releases any stuck Caps Lock at start; -skip_lockkeys ignores lock-key sync from the
    # browser viewer, which otherwise can leave Caps Lock latched so every letter comes out uppercase.
    x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 -clear_all -skip_lockkeys &
    websockify --web /usr/share/novnc 6080 localhost:5900 &
    exec node /app/dist/index.js login "${2:-30}"
    ;;
  serve)
    exec node /app/dist/index.js serve --http
    ;;
  *)
    exec node /app/dist/index.js "$@"
    ;;
esac
