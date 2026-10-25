# Remote (HTTP) connector for claude.ai custom connectors. See docs/deployment.md.
# The base image is pinned by digest for reproducible builds; Dependabot keeps it current.

# The output is plain JavaScript (no native modules), so it is built once on the build machine's own platform,
# also when the image is for another architecture.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# No RUN steps here, so images for other architectures build without emulation.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
LABEL org.opencontainers.image.title="claude-linkedin-connector" \
      org.opencontainers.image.description="Remote MCP server (custom connector) that lets Claude use your LinkedIn account" \
      org.opencontainers.image.source="https://github.com/adamw7/claude-linkedin-connector" \
      org.opencontainers.image.documentation="https://github.com/adamw7/claude-linkedin-connector/blob/main/docs/deployment.md" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The image's node user, by number so Kubernetes' runAsNonRoot can verify it. The server writes nothing to disk,
# so it also runs with a read-only root file system.
USER 1000:1000
EXPOSE 3000
# busybox wget, never through a proxy (-Y off) even if one is configured.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -Y off -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "dist/index.js", "http"]
