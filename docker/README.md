# Docker Dev Container

Fully isolated development environment, configured via `.env` to use Zhipu AI.

## Architecture

```
.env (API Key) -> docker-compose.yml -> container env vars -> Claude Code
```

Config is injected via `.env`, **completely isolated from host**.

## Auto Config Restore

On startup the container automatically checks and restores Claude config:

1. Check if `~/.claude.json` exists
2. If not, try restoring from `~/.claude/backups/` (latest backup)
3. If no backup, create default config
4. Also initialize `~/.claude/settings.json`

## Quick Start

```bash
# 1. Edit .env, fill in API Key
# ANTHROPIC_API_KEY=your-api-key

# 2. Build and start
docker compose up -d --build

# 3. Enter container
docker exec -it -u app dev-container bash

# 4. First run of Claude Code
claude
# When prompted "Do you want to use this API key?" select Yes

# 5. Test
claude -p "hello"
```

## Isolation

| Directory | Type | Description |
|-----------|------|-------------|
| /home/app/project | Bind Mount | Project dir, two-way sync with host |
| /home/app/.claude | Docker Volume | Claude config, fully isolated |
| /home/app/.config/opencode | Docker Volume | OpenCode config, fully isolated |

## Troubleshooting

```bash
# Manual config restore when files are lost
docker exec -it dev-container ls /home/app/.claude/backups/
docker exec -it dev-container cp /home/app/.claude/backups/.claude.json.backup.XXX /home/app/.claude.json

# Rebuild container (preserves Volume data)
docker compose down && docker compose up -d

# Full reset (deletes all config)
docker compose down -v && docker compose up -d --build
```

## Common Commands

```bash
docker compose logs -f          # View logs
docker compose down             # Stop
docker compose build --no-cache # Rebuild
docker volume ls                # List volumes
```
