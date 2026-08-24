# Viral Clip Finder

Fully automatic viral-moment discovery. It searches YouTube and Reddit on a schedule, cheaply
filters what it finds, runs a two-pass Claude vision analysis on promising videos to locate the
actual viral moment (not just "the video"), scores it 0-100, and — for anything above your
threshold — renders a clean 9:16 export (smart-cropped, original audio, no captions/music/effects
added). You open the dashboard and clips are already waiting.

No upload-first workflow: the normal path is zero uploads, zero manual searching.

## Architecture

```
src/
  sources/            Pluggable discovery-source connectors (youtube, reddit), one shared
                       VideoSource interface — add a new platform without touching discovery/
  discovery/           Query generation + rotation, cheap metadata scoring, deduplication,
                       runDiscovery.ts orchestrates one discovery run
  ai/
    providers/claude.ts  Structured-output Claude vision calls (Zod schema, forced JSON)
    pricing.ts            Approximate $/token pricing for the cost dashboard
    costTracking.ts        Records every AI call as an ApiUsage row + daily budget check
  video/
    acquire.ts               Media-acquisition provider abstraction — routes each source's
                              VideoAvailability to yt-dlp or a plain HTTP download; the only
                              thing jobs/ should call to get bytes onto local disk
    acquisitionErrors.ts       Classifies a failure as rate_limited / bot_check / login_required /
                                binary_missing / ffmpeg_missing / unknown (pure, unit-tested)
    acquisitionThrottle.ts     Pacing between yt-dlp calls + AcquisitionCircuitBreaker
    ytdlp.ts                    The yt-dlp invocation itself (--js-runtimes node, cookies)
    ytdlpCookies.ts               Optional authenticated access — see "Media acquisition" below
    ffmpeg.ts               probe / extractFrames wrappers
    smartCrop.ts             Subject bounding boxes -> smoothed 9:16 pan keyframes (no zoom,
                              no artificial camera movement)
    objectTracking.ts         Swappable ObjectTracker interface (Claude-vision-derived by default)
    renderVertical.ts          ffmpeg crop+scale render — no captions, music, or effects, ever
  analysis/
    quickScan.ts             Pass 1: sparse whole-video scan -> generously padded candidate windows
    detailedAnalysis.ts       Pass 2: dense scan of one window -> moment + scores + subject bboxes
    schemas.ts                 Zod schemas shared by both passes
  scoring/viralScore.ts      0-100 viral score = mean of the 11 sub-scores
  jobs/
    discovery.ts / analysis.ts / processing.ts   One job per pipeline stage, persistence-aware
    pipeline.ts                                    Runs all three stages end to end
  worker/
    index.ts                 Long-running scheduler (node-cron) — the primary driver
    runOnce.ts                 One-shot pipeline run (`npm run worker:once`)
  database/               Prisma client, typed settings store, moment queries
    acquisitionCooldown.ts   Exponential backoff for a source that's actively blocking us
  storage/                Where rendered clips live — local disk or S3-compatible object
                           storage (index.ts picks the backend; see "Deploying to Railway")
  app/                    Next.js dashboard (App Router) + JSON API routes
```

### Pipeline

```
DISCOVER (sources/*, discovery/) -> FILTER (candidateScoring, deduplication)
  -> QUICK SCAN (analysis/quickScan.ts, sparse frames, cheap)
  -> DETAILED ANALYSIS (analysis/detailedAnalysis.ts, dense frames on candidates only)
  -> VIRAL SCORE (scoring/viralScore.ts)
  -> 9:16 RENDER (video/renderVertical.ts, only for moments above the threshold)
  -> DASHBOARD
```

Cost control is layered on purpose: cheap metadata scoring runs on every discovered video, but
Claude vision only ever looks at videos that pass that filter (quick scan), and only re-analyzes
densely inside windows the quick scan already flagged (detailed analysis). All of this is
configurable from **Settings** (candidates/quick-scans/detailed-analyses per run, minimum viral
score, daily AI budget).

### Media acquisition: being discovered ≠ being downloadable

Discovery (finding a video via the YouTube Data API or Reddit's API) and media acquisition
(actually fetching that video's bytes) are deliberately separate concerns — a video the YouTube
API happily returns is not guaranteed to be fetchable by yt-dlp from wherever this app happens to
be hosted. In production this isn't hypothetical: YouTube actively rate-limits and bot-challenges
requests from datacenter IPs (Railway included), independent of anything about the video itself.

- **`src/video/acquire.ts`** is the only place `jobs/analysis.ts`/`jobs/processing.ts` go to turn
  a discovered video into local bytes. It's a small provider abstraction: a source's
  `VideoAvailability.acquisitionMethod` says whether to use yt-dlp (YouTube; most Reddit-hosted
  videos, which split audio/video into separate streams yt-dlp merges) or a plain HTTP download
  (a Reddit post that links straight at an `.mp4`/`.mov`/`.webm` — no extractor, and no
  yt-dlp/YouTube-style blocking risk at all for that path). Adding a source with directly
  permitted media URLs means implementing `VideoSource` and setting `acquisitionMethod:
  "direct-http"` on its `VideoAvailability` — nothing about acquisition needs to change.
- **`src/video/acquisitionErrors.ts`** classifies a yt-dlp failure into `rate_limited` (HTTP 429),
  `bot_check` ("Sign in to confirm you're not a bot"), `login_required`, `binary_missing`
  (yt-dlp itself isn't on PATH), `ffmpeg_missing`, or `unknown`. The first three are treated as
  the *source* actively refusing us, not an ordinary per-video failure.
- On an access-blocked result, the source video's status becomes `source_access_blocked` (not the
  generic `error`) with the reason stored, and it's scheduled for another attempt only after an
  exponential-backoff cooldown (`src/database/acquisitionCooldown.ts`: 30min, 1h, 2h, ... capped
  at 24h) — never immediately on the next 5-minute worker tick. The discovered row itself (title,
  URL, metadata, and any moments already found before acquisition started failing) is left alone;
  only the processing/render status is affected, and the pipeline moves on to the next candidate.
- **`src/video/acquisitionThrottle.ts`** enforces a minimum delay between yt-dlp calls
  (`YOUTUBE_ACQUISITION_DELAY_MS`, default 5s — acquisitions are already sequential by
  construction, this just paces them) and an `AcquisitionCircuitBreaker`: after
  `YOUTUBE_CIRCUIT_BREAKER_THRESHOLD` (default 3) *consecutive* access-blocked results within one
  discovery or render run, that run stops trying further candidates instead of working through
  dozens of doomed requests in seconds.
- **Do not assume yt-dlp will always work.** This is the load-bearing production assumption to
  avoid — see requirement 6 in the PR that added this section. The system is built to degrade
  gracefully: a blocked video doesn't crash the run, doesn't get retried immediately, and doesn't
  stop other candidates (or other sources) from being processed.

**Optional authenticated access** (`YTDLP_COOKIES_BASE64`, `src/video/ytdlpCookies.ts`): a
base64-encoded yt-dlp `cookies.txt`, entirely optional — the app starts and runs identically
without it. This is a fallback, not a production strategy: the account it belongs to can itself
get rate-limited or flagged, and cookies expire. Never hardcode cookies/credentials, and this is
never logged (only whether one is configured, never its content).

**Startup self-test** (`src/lib/selfTest.ts`): both `npm run start` and `npm run start:worker` log
yt-dlp/ffmpeg/Node versions and whether a `node` binary is resolvable (the same thing yt-dlp's
`--js-runtimes node` needs to find) once at boot — check a service's logs after deploying to
confirm the video pipeline is actually usable in that container. No secrets are ever included.

### Why a separate `worker` process

Discovery and analysis do real work over minutes, not milliseconds (video download, AI vision
calls, ffmpeg renders) — that doesn't fit inside a request/response cycle. `src/worker/index.ts`
is a small long-running Node process (`node-cron` inside, no Redis/queue) that ticks every 5
minutes: it runs discovery when the configured frequency says it's due, then always drains
whatever's queued for analysis and rendering. The web app's "Run discovery now" button
(`POST /api/discovery/run`) fires the same pipeline in-process as a fire-and-forget call for
convenience, but the worker is what makes this actually automatic — run both processes in
production.

### Smart 9:16 cropping, no fake zooms

Pass-2 analysis reports subject bounding boxes at a handful of instants across the moment (see
`tracked_keyframes` in `src/analysis/schemas.ts`). `video/smartCrop.ts` turns that into a smoothed
pan path — a fixed-size crop window that pans left/right or up/down (never both, and never
zooms) to keep the subject(s) framed, rate-limited so it never jump-cuts. `video/renderVertical.ts`
turns that into a single ffmpeg `crop` filter with a piecewise-linear position expression, then
scales to 1080x1920. Nothing else is added — see `docs on "no creative editing"` below.

### Deliberately not included

Per the product brief, the 9:16 export is **clean footage only**: original audio, correct
section, smart framing. No captions, subtitles, text overlays, music, voice-over, filters,
transitions, or watermarks are ever added — that's left for you to do afterward in your own
editor. If you're looking for that kind of automated captioning/effects pipeline, it does not
belong in this codebase — do not add it here without deliberately revisiting this decision.

## Setup

### 1. Requirements

- Node.js 20.9+
- A Postgres database (Supabase, Neon, Railway, or self-hosted)
- `ffmpeg` / `ffprobe` on `PATH`
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on `PATH`

### 2. Credentials

Copy `.env.example` to `.env` and fill in:

| Variable | Required for | Where to get it |
| --- | --- | --- |
| `DATABASE_URL` | everything | your Postgres provider |
| `ANTHROPIC_API_KEY` | AI analysis/scoring | console.anthropic.com |
| `YOUTUBE_API_KEY` | YouTube discovery | Google Cloud Console → enable "YouTube Data API v3" |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | Reddit discovery | reddit.com/prefs/apps → create a "script" app |
| `APP_PASSWORD` | gating the site once deployed | pick one yourself; unset disables the login page |

Without `ANTHROPIC_API_KEY`/`YOUTUBE_API_KEY`/Reddit credentials, the app still runs — discovery
and analysis for that source just fail loudly (logged to the Error Log / that source's videos get
marked `error`) instead of pretending to work.

### 3. Install & migrate

```bash
npm install
npx prisma migrate deploy   # or `npm run db:migrate` for a fresh dev database
npm run db:seed             # registers the youtube/reddit source rows
```

### 4. Run

```bash
npm run dev      # the dashboard, http://localhost:3000
npm run worker   # the background discovery/analysis/render loop — run this too, separately
```

In production, run both as long-lived processes (e.g. two services on Railway/Render/Fly, or two
processes under a process manager). This app is not designed for stateless serverless functions —
video download/analysis/rendering are minutes-long, stateful, disk-using operations.

## Deploying to Railway

The repo ships one `Dockerfile` (Node 22 + ffmpeg + yt-dlp) shared by both services, and a root
`railway.json` that only declares the **build** (`builder: DOCKERFILE`) — deliberately nothing
about start commands or health checks. Railway applies `railway.json` as a default to every
service deployed from this repo, and per-service fields committed there (like `deploy.*`) end up
applying to *all* of them, including a worker with no HTTP server to health-check. Per-service
**Start Command** and **Healthcheck Path**, set directly in each service's Settings in the Railway
dashboard, always take priority over `railway.json` — that's the reliable way to make one service
a web server and another a worker from the same repo, rather than committing a second
"config-as-code" file and pointing a service at it by path (that per-service file-path override
does not reliably isolate every field, which is exactly the healthcheck bleed-through this section
fixes — don't reintroduce it).

### 1. Create the project

1. New Railway project → **Deploy from GitHub repo** → this repo. This becomes your **web**
   service.
2. **+ New → Database → PostgreSQL.** Railway provisions it and exposes a `DATABASE_URL`
   reference variable other services in the project can consume.
3. **+ New → GitHub repo** again, same repo, to create the **worker** service.
4. Configure each service's Settings → **Deploy** tab directly (see the table below) — do **not**
   rely on `railway.json` for anything past the Dockerfile build.

| Service | Start Command | Healthcheck Path |
| --- | --- | --- |
| **web** | `npx prisma migrate deploy && npm run start` | `/api/health` |
| **worker** | `npx prisma migrate deploy && npm run start:worker` | *(leave empty — no HTTP server to check)* |

If the worker service shows a Healthcheck Path left over from before (e.g. `/api/health` inherited
from `railway.json`), clear it explicitly in its Settings — an empty Healthcheck Path means
Railway just tracks whether the process is running, which is the correct behavior for a background
worker.

### 2. Storage bucket (S3-compatible)

The worker renders 9:16 clips; the web service's `/api/media/[momentId]` route (the preview
player and "Download 9:16" button) reads them back — but web and worker are **separate
containers** on Railway, and Railway Volumes cannot be attached to more than one service. Use a
Railway **Storage Bucket** (S3-compatible object storage) instead, which both services reach over
the network rather than a shared disk:

1. **+ New → Storage → Bucket** in your Railway project.
2. From the bucket's **Variables**/**Connect** tab, copy its endpoint, bucket name, access key,
   and secret key into the `S3_*` variables below.
3. Set those variables on **both** the web and worker services.

The worker uploads each rendered clip straight to the bucket (`src/storage/s3.ts`); the web
service serves it back by redirecting to a short-lived presigned URL (`src/storage/index.ts` picks
the S3 backend automatically whenever `S3_BUCKET` is set — see `src/storage/` for the full
local-vs-S3 abstraction). Presigned URLs support HTTP Range requests on their own, so video
seeking still works without the app proxying any bytes itself.

Leave `SCRATCH_DIR` on its default (local, ephemeral `/tmp`) on both services — it's only used
mid-job for downloaded source video and extracted frames, deleted again as soon as that job
finishes, so it never needs to be shared or to persist. `STORAGE_DIR` also stays on its default;
it's only read when `S3_BUCKET` is unset (local development).

### 3. Environment variables

Set these on **both** the web and worker services (Railway lets you share a variable across
services via a shared variable group, or just paste the same values twice):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | reference the Postgres service's `DATABASE_URL` |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `YOUTUBE_API_KEY` | your YouTube Data API v3 key |
| `APP_PASSWORD` | a password of your choosing, to gate the dashboard |
| `S3_BUCKET` | your Storage Bucket's name |
| `S3_ENDPOINT` | your Storage Bucket's endpoint URL |
| `S3_ACCESS_KEY_ID` | your Storage Bucket's access key |
| `S3_SECRET_ACCESS_KEY` | your Storage Bucket's secret key |
| `S3_REGION` | your Storage Bucket's region if it has one; otherwise leave unset (defaults to `auto`) |

`REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` can be left unset for now — Reddit starts out disabled
(see below) and only needs credentials once you enable it from the Sources page.

### 4. Migrations

Both services' Start Commands (set in step 1) run `npx prisma migrate deploy` before starting
their actual process. This is safe to run from both services on every deploy — Prisma's migration
runner takes a database-level lock, so if both containers start at once, one just waits its turn
instead of racing.

### 5. First live test — production-safe by default

A fresh database's `Settings` start out deliberately narrow (`src/database/settings.ts`
`DEFAULT_SETTINGS`), and `npm run db:seed`/the worker's own startup seeding only enables the
YouTube source, so the very first run is small on purpose:

- Source: **YouTube only** (Reddit seeded as disabled)
- Category: **Road Rage only**
- Candidates per discovery run: **20**
- Quick scans per run: **5**
- Detailed analyses per run: **2**
- 9:16 renders per run: **2**

That's the whole pipeline exercised end to end — YouTube search → download (yt-dlp) → frame
extraction (ffmpeg) → Claude vision (quick scan, then detailed analysis) → start/peak/end
timestamps + viral score → smart-cropped ffmpeg 9:16 render → visible on the dashboard — without
risking a large AI/API bill on the first deploy. Once you've confirmed a clip makes it all the way
through, raise the limits and enable more categories/sources from the **Settings** page; nothing
about that verification changes what's safe to raise later.

To kick off that first run immediately instead of waiting for the worker's next scheduled tick,
open the dashboard and click **Run discovery now**, or watch the worker service's logs — it ticks
every 5 minutes and logs each stage (`[worker] running discovery` / `analysis` / `processing`).

## Testing

```bash
npm run typecheck   # runs `next typegen` first, then tsc --noEmit
npx eslint .        # lint
npm test             # node:test via tsx, no framework dependency — src/**/*.test.ts
npm run build        # production build
```

The test suite covers the pure/classification logic directly (`node:test`, colocated
`*.test.ts` files, no separate framework — `tsx` is already a dependency): acquisition failure
classification (429, bot-check, LOGIN_REQUIRED, ENOENT for both yt-dlp and ffmpeg, an unrelated
failure staying `unknown`) in `src/video/acquisitionErrors.test.ts` and `src/lib/proc.test.ts`
(the latter against real fake-binary child processes, not mocks), the circuit breaker in
`src/video/acquisitionThrottle.test.ts`, and the exponential-backoff math in
`src/database/acquisitionCooldown.test.ts`.

There is no synthetic-video/ffmpeg integration test suite (unlike a project with committed sample
media, this repo has none checked in) — `video/renderVertical.ts`'s actual ffmpeg filter-graph
output should be spot-checked against a real clip before relying on it, the same way
`smartCrop.ts`'s pan math should be sanity-checked against a real moment with two tracked
subjects. **`ffmpeg`/`ffprobe`/`yt-dlp` were not available in the sandbox this project was built
in**, so the video pipeline (download, frame extraction, smart-crop render) is implemented and
typechecked but has not been run end-to-end against real binaries or real YouTube — verify it in
a deployed environment before relying on it. Everything else (discovery, dedup, scoring math, API
routes, dashboard, the direct-http acquisition path, the self-test's graceful handling of missing
binaries) has been exercised for real — against a real local Postgres database, a running dev/prod
server, a real local HTTP server standing in for a direct-media source, and this sandbox's own
genuinely-missing yt-dlp/ffmpeg (a real instance of the "gracefully degrade" case).

## Adding a new source

Implement `VideoSource` (`src/sources/types.ts`) in a new `src/sources/<name>/` folder, then add
one line to `SOURCE_REGISTRY` in `src/sources/registry.ts`. If the platform doesn't allow
downloading video, still implement discovery/metadata and have `getVideoSource` return
`{ downloadable: false, reason: "..." }` — the moment still shows up with its original timestamps
and source link, it just won't get a 9:16 export.
