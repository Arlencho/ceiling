#!/usr/bin/env bash
# Keep the watcher alive across reboots and logouts.
#
# The seven day history is the one deliverable that fails by starting late and
# cannot be recovered afterwards, so it must not depend on a terminal staying
# open. This installs a launchd agent that starts the watcher at login and
# restarts it if it exits.
#
#   ./scripts/watcher-service.sh install
#   ./scripts/watcher-service.sh status
#   ./scripts/watcher-service.sh uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="tech.veto.watcher"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
NODE="$(command -v node || true)"

case "${1:-status}" in
  install)
    [ -n "$NODE" ] || { echo "node is not on PATH"; exit 1; }
    [ -f "${ROOT}/watcher/dist/index.js" ] || { echo "build the watcher first: cd watcher && npm run build"; exit 1; }
    mkdir -p "${HOME}/Library/LaunchAgents" "${ROOT}/watcher/logs"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/watcher/dist/index.js</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}/watcher</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${ROOT}/watcher/logs/watcher.out</string>
  <key>StandardErrorPath</key><string>${ROOT}/watcher/logs/watcher.err</string>
</dict>
</plist>
PLIST_EOF
    pkill -f "dist/index.js run" 2>/dev/null || true
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "installed ${LABEL}; it now starts at login and restarts on exit"
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed ${LABEL}"
    ;;
  status)
    if launchctl list | grep -q "$LABEL"; then
      echo "launchd: $(launchctl list | grep "$LABEL")"
    else
      echo "launchd: not installed"
    fi
    pgrep -f "dist/index.js run" >/dev/null && echo "process: running" || echo "process: not running"
    [ -f "${ROOT}/watcher/data/decisions.jsonl" ] && echo "decisions: $(grep -c . "${ROOT}/watcher/data/decisions.jsonl")"
    ;;
  *) echo "usage: $0 install|status|uninstall"; exit 1 ;;
esac
