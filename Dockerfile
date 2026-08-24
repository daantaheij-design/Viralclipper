# Single image shared by both Railway services (web + worker) — see
# railway.json / railway.worker.json for the per-service start commands that
# select which process actually runs. Kept as one straightforward stage
# (rather than a slimmed-down multi-stage build) because the worker service
# needs the full TypeScript source tree + tsx + the Prisma CLI at runtime,
# not just the compiled Next.js output the web service needs — there's
# nothing meaningful left to prune between "build" and "runtime" here.

FROM node:22-slim

# ffmpeg/ffprobe (video pipeline), yt-dlp's own runtime deps (python3,
# ca-certificates for its HTTPS calls), and openssl (required by Prisma's
# query engine on Debian).
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

# Default process is the web app; the worker service overrides this via its
# own railway.worker.json startCommand (see README's Railway deploy section).
CMD ["npm", "run", "start"]
