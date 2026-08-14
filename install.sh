#!/usr/bin/env bash
set -euo pipefail

BIN="$HOME/.local/bin"
CFG="$HOME/.config/claude-window"
UNIT=/etc/systemd/system/claude-window.service
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v curl >/dev/null || { echo "curl requis"; exit 1; }
command -v systemctl >/dev/null || { echo "systemd requis"; exit 1; }

mkdir -p "$BIN" "$CFG"
install -m 755 "$SRC/claude-window" "$BIN/claude-window"

if [[ ! -f "$CFG/env" ]]; then
  printf 'CLAUDE_CODE_OAUTH_TOKEN=\n' > "$CFG/env"
fi
chmod 600 "$CFG/env"

sed -e "s|REPLACE_USER|$USER|g" -e "s|REPLACE_HOME|$HOME|g" \
  "$SRC/systemd/claude-window.service" | sudo tee "$UNIT" >/dev/null
sudo systemctl daemon-reload

echo
echo "installed."
echo
if ! grep -q 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat' "$CFG/env" 2>/dev/null; then
  echo "token still missing. on your workstation:"
  echo "    claude setup-token"
  echo "then here:"
  echo "    printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' 'sk-ant-oat01-...' > $CFG/env"
  echo "    sudo systemctl enable --now claude-window"
else
  echo "    sudo systemctl enable --now claude-window"
fi
