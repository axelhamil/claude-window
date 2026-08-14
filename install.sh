#!/usr/bin/env bash
set -euo pipefail

BIN="$HOME/.local/bin"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/claude-window"
UNIT=/etc/systemd/system/claude-window.service
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v curl >/dev/null || { echo "curl required"; exit 1; }
command -v systemctl >/dev/null || { echo "systemd required"; exit 1; }

mkdir -p "$BIN" "$CFG"
install -m 755 "$SRC/claude-window" "$BIN/claude-window"
echo "$SRC" > "$CFG/src"

if [[ ! -f "$CFG/env" ]]; then
  printf 'CLAUDE_CODE_OAUTH_TOKEN=\n' > "$CFG/env"
fi
chmod 600 "$CFG/env"

rendered=$(sed -e "s|REPLACE_USER|$USER|g" -e "s|REPLACE_HOME|$HOME|g" "$SRC/systemd/claude-window.service")
if [[ ! -f $UNIT ]] || ! printf '%s\n' "$rendered" | cmp -s - "$UNIT"; then
  printf '%s\n' "$rendered" | sudo tee "$UNIT" >/dev/null
  sudo systemctl daemon-reload
  echo "unit updated"
fi

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "note: $BIN is not in your PATH" ;;
esac

echo "installed $("$BIN/claude-window" version | awk '{print $2}')"

if ! grep -q 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat' "$CFG/env" 2>/dev/null; then
  echo
  echo "token still missing. on your workstation:"
  echo "    claude setup-token"
  echo "then here:"
  echo "    printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' 'sk-ant-oat01-...' > $CFG/env"
  echo "    sudo systemctl enable --now claude-window"
fi
