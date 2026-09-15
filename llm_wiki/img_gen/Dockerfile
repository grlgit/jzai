# =============================================================================
# LLM Wiki — pre-built Docker image (local mode)
# Next.js frontend is pre-compiled; only Python deps are installed at build time.
#
# Build:  docker build -t llmwiki .
# Run:    docker run -p 3000:3000 -p 8000:8000 -p 8080:8080 -v /path/to/workspace:/workspace llmwiki
# =============================================================================

FROM python:3.11-slim-bookworm

# Install Node.js runtime (no build tools needed — frontend is pre-compiled)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install Python dependencies
COPY api/requirements.txt /app/api/requirements.txt
COPY mcp/requirements.txt /app/mcp/requirements.txt
RUN pip install --no-cache-dir --timeout=120 -r /app/api/requirements.txt && \
    pip install --no-cache-dir --timeout=120 -r /app/mcp/requirements.txt

# Copy API + MCP + shared code
COPY api/          /app/api/
COPY mcp/          /app/mcp/
COPY shared/       /app/shared/
COPY llmwiki       /app/llmwiki
RUN chmod +x /app/llmwiki

# Copy pre-built Next.js standalone app
COPY web_standalone/ /app/web/

# Copy reference files for enterprise setup
COPY SCHEMA.md.sample /app/SCHEMA.md.sample
COPY MANUAL.md /app/MANUAL.md

# Copy entrypoint
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Default workspace mount point
RUN mkdir -p /workspace

ENV MODE=local \
    NEXT_PUBLIC_MODE=local \
    WORKSPACE_PATH=/workspace \
    APP_URL=http://localhost:3000 \
    API_URL=http://localhost:8000 \
    MCP_URL=http://localhost:8080/mcp \
    DATABASE_URL=""

EXPOSE 3000 8000 8080

VOLUME ["/workspace"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
