#!/bin/bash
set -e

CLAUDE_CONFIG="/home/app/.claude.json"
CLAUDE_DIR="/home/app/.claude"
BACKUP_PATTERN="/home/app/.claude/backups/.claude.json.backup.*"

# Ensure .claude directory exists
mkdir -p "$CLAUDE_DIR/backups"

# Check and restore config file
restore_config() {
    if [ ! -f "$CLAUDE_CONFIG" ]; then
        echo "Claude config not found, attempting restore..."

        # Find latest backup
        LATEST_BACKUP=$(ls -t $BACKUP_PATTERN 2>/dev/null | head -1)

        if [ -n "$LATEST_BACKUP" ] && [ -f "$LATEST_BACKUP" ]; then
            cp "$LATEST_BACKUP" "$CLAUDE_CONFIG"
            echo "Restored from backup: $LATEST_BACKUP"
        else
            # Create default config
            echo '{"hasCompletedOnboarding": true}' > "$CLAUDE_CONFIG"
            echo "Created default config file"
        fi

        chown app:app "$CLAUDE_CONFIG" 2>/dev/null || true
    fi
}

# Initialize settings.json (if not exists)
init_settings() {
    SETTINGS_FILE="$CLAUDE_DIR/settings.json"

    if [ ! -f "$SETTINGS_FILE" ]; then
        echo "Claude settings.json not found, creating default..."

        cat > "$SETTINGS_FILE" << 'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
EOF
        chown app:app "$SETTINGS_FILE" 2>/dev/null || true
        echo "Created default settings.json"
    fi
}

# Run initialization as appropriate user
if [ "$(id -u)" = "0" ]; then
    # root user: fix permissions then initialize
    chown -R app:app /home/app/.claude /home/app/.config/opencode 2>/dev/null || true
    restore_config
    init_settings
    chown -R app:app /home/app/.claude /home/app/.config/opencode 2>/dev/null || true
else
    # non-root user: initialize directly
    restore_config
    init_settings
fi

echo "Dev container ready"
exec "$@"
