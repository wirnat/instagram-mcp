# Base image with Chromium and its system libraries. The version must match playwright-core in package.json.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

# Xvfb provides a virtual display so Chromium runs headful instead of headless.
# x11vnc and noVNC are only used during login, to view that window from a browser over an SSH tunnel.
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data && chown pwuser:pwuser /data

USER pwuser
ENV INSTAGRAM_MCP_HOME=/data \
    INSTAGRAM_MCP_CHROME_CHANNEL= \
    INSTAGRAM_MCP_NO_SANDBOX=1 \
    INSTAGRAM_MCP_HOST=0.0.0.0 \
    INSTAGRAM_MCP_PORT=48300 \
    DISPLAY=:99
VOLUME /data
EXPOSE 48300
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["serve"]
