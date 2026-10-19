# CompanyIntel indexing container — Cloudflare Containers entrypoint.
#
# This is the Dockerfile `wrangler deploy` builds for the `[[containers]]` binding in
# `wrangler.toml`. It is intentionally at the repository root so the build context is
# the repository root and the `COPY tools`/`COPY cloud` paths resolve. The identical
# image can be built directly with:
#
#   docker build --platform linux/amd64 -t companyintel-indexer .
#   docker run --rm -p 8080:8080 -e R2_ACCOUNT_ID=… -e R2_ACCESS_KEY_ID=… \
#     -e R2_SECRET_ACCESS_KEY=… companyintel-indexer
#
# The image contains ONLY the indexing code path: no frontend build, no Worker. It
# reads sources from R2 over the S3 API and writes compact segments, checkpoints and
# (Cloud Pass 2) the versioned index back to R2. Its own disk never holds the spool or
# the whole index.
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

# `cloud/runner.mjs` exposes /health and POST /job; the CLI checkpoints every chunk
# (Pass 1) or every partition (Pass 2) to R2, so a SIGTERM (15-minute grace) or host
# restart resumes cleanly.
CMD ["bun", "cloud/runner.mjs"]
