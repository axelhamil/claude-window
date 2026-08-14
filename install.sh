#!/usr/bin/env bash
set -euo pipefail

BIN="$HOME/.local/bin"
CFG="$HOME/.config/cc-anchor"
UNIT=/etc/systemd/system/cc-anchor.service
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v curl >/dev/null || { echo "curl requis"; exit 1; }
command -v systemctl >/dev/null || { echo "systemd requis"; exit 1; }

mkdir -p "$BIN" "$CFG"
install -m 755 "$SRC/cc-anchor" "$BIN/cc-anchor"

if [[ ! -f "$CFG/env" ]]; then
  printf 'CLAUDE_CODE_OAUTH_TOKEN=\n' > "$CFG/env"
fi
chmod 600 "$CFG/env"

sed -e "s|REPLACE_USER|$USER|g" -e "s|REPLACE_HOME|$HOME|g" \
  "$SRC/systemd/cc-anchor.service" | sudo tee "$UNIT" >/dev/null
sudo systemctl daemon-reload

echo
echo "installe."
echo
if ! grep -q 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat' "$CFG/env" 2>/dev/null; then
  echo "il reste a poser le token. sur ton poste de travail:"
  echo "    claude setup-token"
  echo "puis ici:"
  echo "    printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' 'sk-ant-oat01-...' > $CFG/env"
  echo "    sudo systemctl enable --now cc-anchor"
else
  echo "    sudo systemctl enable --now cc-anchor"
fi
