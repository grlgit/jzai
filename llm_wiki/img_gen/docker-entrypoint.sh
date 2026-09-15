#!/usr/bin/env bash
set -e

WORKSPACE="${WORKSPACE_PATH:-/workspace}"

start_services() {
    # ── Initialize workspace ───────────────────────────────────────────────
    local INIT_MARKER="$WORKSPACE/.llmwiki/.initialized"
    local DB_FILE="$WORKSPACE/.llmwiki/index.db"

    if [ ! -f "$INIT_MARKER" ] && [ ! -f "$DB_FILE" ]; then
        echo "First install detected — initializing workspace at $WORKSPACE ..."
        mkdir -p "$WORKSPACE/.llmwiki"
        python /app/llmwiki init "$WORKSPACE"
        touch "$INIT_MARKER"
    elif [ -f "$DB_FILE" ]; then
        echo "Existing database detected — checking for schema updates..."
        python /app/shared/db_migrate.py "$WORKSPACE"
        local MIGRATE_EXIT=$?
        if [ $MIGRATE_EXIT -eq 1 ]; then
            echo ""
            echo "ERROR: Database migration failed. Cannot start."
            echo "  If the database is corrupted, you can reset it by removing:"
            echo "    $DB_FILE"
            echo "  WARNING: This will lose all indexed data (source files are preserved)."
            echo ""
            exit 1
        fi
        touch "$INIT_MARKER"
    elif [ ! -f "$DB_FILE" ]; then
        echo "Database not found — initializing workspace at $WORKSPACE ..."
        python /app/llmwiki init "$WORKSPACE"
    fi

    # ── Check setup status ─────────────────────────────────────────────────
    local SETUP_MARKER="$WORKSPACE/.llmwiki/.setup-complete"
    if [ ! -f "$SETUP_MARKER" ]; then
        echo ""
        echo "┌──────────────────────────────────────────────────────────────┐"
        echo "│  Initial setup required.                                     │"
        echo "│  Open http://localhost:3000 to complete the setup wizard.     │"
        echo "└──────────────────────────────────────────────────────────────┘"
        echo ""
    elif [ ! -f "$WORKSPACE/SCHEMA.md" ]; then
        echo "Running in personal (single-user) mode."
    else
        echo "Enterprise mode: SCHEMA.md found."
    fi

    # ── Export env ──────────────────────────────────────────────────────────
    export MODE=local
    export WORKSPACE_PATH="$WORKSPACE"
    export DATABASE_URL=""
    export APP_URL="${APP_URL:-http://localhost:3000}"
    export API_URL="${API_URL:-http://localhost:8000}"
    export MCP_URL="${MCP_URL:-http://localhost:8080/mcp}"

    # ── Start services ──────────────────────────────────────────────────────
    echo "Starting API server on :8000 ..."
    cd /app/api
    python -m uvicorn main:app --host 0.0.0.0 --port 8000 &
    API_PID=$!

    echo "Starting Web server on :3000 ..."
    cd /app/web
    HOSTNAME=0.0.0.0 PORT=3000 node server.js &
    WEB_PID=$!

    echo "Starting MCP server on :8080 ..."
    cd /app/mcp
    python -m local_server --workspace "$WORKSPACE" --http --port 8080 &
    MCP_PID=$!

    echo ""
    echo "LLM Wiki is running:"
    echo "  Web: http://localhost:3000"
    echo "  API: http://localhost:8000"
    echo "  MCP: http://localhost:8080/mcp"
    echo ""
}

stop_services() {
    echo "Stopping services..."
    kill "$API_PID" "$WEB_PID" "$MCP_PID" 2>/dev/null || true
    wait "$API_PID" "$WEB_PID" "$MCP_PID" 2>/dev/null || true
}

# ── Signal handlers ──────────────────────────────────────────────────────

shutdown() {
    echo "Shutting down..."
    stop_services
    exit 0
}

handle_restart() {
    echo ""
    echo "Restart signal received — restarting all services..."
    echo ""
    stop_services
    sleep 1
    rm -f /tmp/.llmwiki-restart
    start_services
}

trap shutdown SIGTERM SIGINT
trap handle_restart SIGUSR1

# ── Main ─────────────────────────────────────────────────────────────────

start_services

# Wait loop — supports restart via SIGUSR1
while true; do
    # wait -n returns when ANY child exits
    if ! wait -n "$API_PID" "$WEB_PID" "$MCP_PID" 2>/dev/null; then
        # wait -n was interrupted by a signal (e.g. SIGUSR1) — that's OK
        # The trap handler will run; if it was a restart, we loop back
        # Check if the restart marker was consumed (services were restarted)
        if [ -f /tmp/.llmwiki-restart ]; then
            # Restart marker still exists — something went wrong
            rm -f /tmp/.llmwiki-restart
        fi
        continue
    fi
    # A child process exited on its own — shut down
    echo "A service exited unexpectedly."
    shutdown
done
