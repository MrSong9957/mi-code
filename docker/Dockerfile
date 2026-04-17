FROM docker.1ms.run/library/debian:bookworm-slim

# Accept proxy as build arg
ARG HTTP_PROXY
ARG HTTPS_PROXY

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl git ca-certificates sudo fonts-noto-cjk \
    python3 python3-pip python3-venv \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code and OpenCode (use npm mirror + proxy if available)
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @anthropic-ai/claude-code opencode-ai

# Create non-root user app (passwordless sudo)
RUN groupadd -g 1000 app && \
    useradd -r -u 1000 -g app -s /bin/bash -d /home/app app && \
    echo 'app ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers

# Set permissions
RUN mkdir -p /home/app/project /home/app/.claude/backups /home/app/.config/opencode && \
    chown -R app:app /home/app

# Copy entrypoint script (fix Windows CRLF line endings)
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /home/app/project
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["tail", "-f", "/dev/null"]
