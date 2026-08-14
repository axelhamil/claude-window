#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly SOURCE_DIR
readonly BIN_DIR=$HOME/.local/bin
readonly CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/claude-window
readonly ENV_FILE=$CONFIG_DIR/env
readonly UNIT_FILE=/etc/systemd/system/claude-window.service

die() { echo "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null || die "$1 is required"; }

install_binary() {
  mkdir -p "$BIN_DIR"
  install -m 755 "$SOURCE_DIR/claude-window" "$BIN_DIR/claude-window"
}

install_config() {
  mkdir -p "$CONFIG_DIR"
  printf '%s\n' "$SOURCE_DIR" >"$CONFIG_DIR/src"
  [[ -f $ENV_FILE ]] || printf 'CLAUDE_CODE_OAUTH_TOKEN=\n' >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

install_unit() {
  local rendered
  rendered=$(sed -e "s|REPLACE_USER|$USER|g" -e "s|REPLACE_HOME|$HOME|g" \
    "$SOURCE_DIR/systemd/claude-window.service")

  if [[ -f $UNIT_FILE ]] && printf '%s\n' "$rendered" | cmp -s - "$UNIT_FILE"; then
    return 0
  fi

  printf '%s\n' "$rendered" | sudo tee "$UNIT_FILE" >/dev/null
  sudo systemctl daemon-reload
  echo "unit updated"
}

token_missing() {
  ! grep -q 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat' "$ENV_FILE" 2>/dev/null
}

print_next_steps() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "note: $BIN_DIR is not in your PATH" ;;
  esac

  echo "installed $("$BIN_DIR/claude-window" version | awk '{print $2}')"

  token_missing || return 0
  cat <<-EOF

	token still missing. on your workstation:
	    claude setup-token
	then here:
	    printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' 'sk-ant-oat01-...' > $ENV_FILE
	    sudo systemctl enable --now claude-window
	EOF
}

require curl
require systemctl

install_binary
install_config
install_unit
print_next_steps
