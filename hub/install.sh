#!/usr/bin/env bash
# Install pi-hub as a systemd user service on this machine. Re-runnable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

sed -e "s|__NODE__|$NODE_BIN|" -e "s|__REPO__|$REPO_ROOT|" \
  "$REPO_ROOT/hub/pi-hub.service" > "$UNIT_DIR/pi-hub.service"

systemctl --user daemon-reload
systemctl --user enable --now pi-hub
# survive logout
loginctl enable-linger "$USER" 2>/dev/null || true

sleep 1
systemctl --user --no-pager status pi-hub | head -5
echo
echo "pi-hub installed. Front it with:"
echo "  sudo tailscale serve --bg --https=8448 http://127.0.0.1:4200"
echo "Enable per-session registration in ~/.pi/agent/settings.json:"
echo '  "remoteRegister": { "hubUrl": "http://127.0.0.1:4201" }'
