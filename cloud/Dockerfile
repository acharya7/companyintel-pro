# CompanyIntel cloud indexer container.
#
# Build (Cloudflare Containers requires linux/amd64):
#   docker build --platform linux/amd64 -f cloud/Dockerfile -t companyintel-indexer .
#
# The image contains ONLY the indexing code path: no frontend build, no Worker.
# It reads sources from R2 over the S3 API and writes compact segments and
# checkpoints back to R2, so the container's own disk holds at most one chunk's
# buffers (tens of MB) and never the spool.
#
# Pinned to the Bun line the repository is tested and locked with. `bun.lock` is
# lockfile format 2; `oven/bun:1.2-slim` ships Bun 1.2.23, which refuses it with
# "Unknown lockfile version", so the image must not move back below 1.4.
FROM oven/bun:1.4.3-slim

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tools ./tools
COPY cloud ./cloud
COPY src/shared ./src/shared
COPY tsconfig.json ./

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

# `runner.mjs` exposes /health and POST /job; the CLI writes progress to R2 after
# every chunk, so a SIGTERM (15-minute grace) or host restart resumes cleanly.
CMD ["bun", "cloud/runner.mjs"]
