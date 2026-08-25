# Single image shared by both Railway services (web + worker) — Start
# Command differs per service, set in each service's own Railway dashboard
# Settings (see README's "Deploying to Railway"), not in this file. Kept as
# one straightforward stage (rather than a slimmed-down multi-stage build)
# because the worker service needs the full TypeScript source tree + tsx +
# the Prisma CLI at runtime, not just the compiled Next.js output the web
# service needs — there's nothing meaningful left to prune between "build"
# and "runtime" here.

FROM node:22-slim

# ffmpeg/ffprobe (video pipeline), yt-dlp's own runtime deps (python3,
# ca-certificates for its HTTPS calls), and openssl (required by Prisma's
# query engine on Debian). Node itself is already present (base image) —
# yt-dlp needs a real JS runtime to solve YouTube's player challenges, and
# every yt-dlp invocation passes `--js-runtimes node` explicitly (see
# src/video/ytdlp.ts) rather than relying on yt-dlp's own auto-detection.
# `releases/latest` keeps yt-dlp itself current, which matters here more
# than for most tools — YouTube's challenges and yt-dlp's countermeasures
# both change frequently.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    openssl \
    ca-certificates \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: package.json's postinstall runs `prisma generate`, which
# needs prisma/schema.prisma — not copied in yet at this point. Generate
# explicitly below instead, once the full source tree is present.
RUN npm ci --ignore-scripts

COPY . .

RUN npx prisma generate
RUN npm run build

EXPOSE 3000

# Both `npm run start` (web) and `npm run start:worker` log a startup
# self-test (yt-dlp/ffmpeg/node versions, whether yt-dlp's JS runtime
# requirement is satisfiable) — see src/lib/selfTest.ts. Check the
# service's logs after a deploy to confirm the video pipeline is actually
# usable in this container, not just that the build succeeded.
#
# Default process is the web app; the worker service overrides this via its
# own Start Command in the Railway dashboard (see README's Railway deploy
# section) — not via a second committed config file.
CMD ["npm", "run", "start"]
