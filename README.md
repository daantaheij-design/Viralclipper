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
    ytdlp.ts               Downloads source video (yt-dlp)
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

The repo ships a `Dockerfile` (Node 22 + ffmpeg + yt-dlp) and two Railway config-as-code files —
`railway.json` (web service, the default Railway picks up) and `railway.worker.json` (worker
service, point a second service at this file explicitly). Both services build from the same
Dockerfile/image; only the start command differs.

### 1. Create the project

1. New Railway project → **Deploy from GitHub repo** → this repo. This becomes your **web**
   service; Railway auto-detects `railway.json` (Dockerfile build, `npm run start`, health check
   at `/api/health`).
2. **+ New → Database → PostgreSQL.** Railway provisions it and exposes a `DATABASE_URL`
   reference variable other services in the project can consume.
3. **+ New → GitHub repo** again, same repo, to create the **worker** service. In its
   Settings → **Config-as-code**, set the file path to `railway.worker.json` so it runs
   `npm run start:worker` instead of the web server.

### 2. Shared storage volume

The worker renders 9:16 clips to local disk; the web service's `/api/media/[momentId]` route (the
preview player and "Download 9:16" button) reads them back — but web and worker are **separate
containers**, so local disk isn't shared between them unless you attach a volume to both:

1. On the **worker** service: Settings → **Volumes** → create a volume, mount path `/data/storage`.
2. Attach that **same volume** to the **web** service too, same mount path `/data/storage`.
3. Set `STORAGE_DIR=/data/storage` as a variable on **both** services.

Leave `SCRATCH_DIR` on its default (local, ephemeral `/tmp`) — it's only used mid-job for
downloaded source video and extracted frames, which are deleted again as soon as that job
finishes, so it never needs to be shared or to persist.

### 3. Environment variables

Set these on **both** the web and worker services (Railway lets you share a variable across
services via a shared variable group, or just paste the same values twice):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | reference the Postgres service's `DATABASE_URL` |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `YOUTUBE_API_KEY` | your YouTube Data API v3 key |
| `APP_PASSWORD` | a password of your choosing, to gate the dashboard |
| `STORAGE_DIR` | `/data/storage` (see above) |

`REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` can be left unset for now — Reddit starts out disabled
(see below) and only needs credentials once you enable it from the Sources page.

### 4. Migrations

Both `railway.json` and `railway.worker.json` start commands run `npx prisma migrate deploy`
before starting their actual process. This is safe to run from both services on every deploy —
Prisma's migration runner takes a database-level lock, so if both containers start at once, one
just waits its turn instead of racing.

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
npm run build        # production build
```

There is no synthetic-video/ffmpeg integration test suite yet (unlike a project with committed
sample media, this repo has none checked in) — `video/renderVertical.ts`'s actual ffmpeg
filter-graph output should be spot-checked against a real clip before relying on it, the same way
`smartCrop.ts`'s pan math should be sanity-checked against a real moment with two tracked
subjects. **`ffmpeg`/`ffprobe`/`yt-dlp` were not available in the sandbox this project was built
in**, so the video pipeline (download, frame extraction, smart-crop render) is implemented and
typechecked but has not been run end-to-end against real binaries — verify it in an environment
with those installed before relying on it. Everything else (discovery, dedup, scoring math, API
routes, dashboard) has been exercised against a real local Postgres database and a running dev
server, including a full visual pass over the UI.

## Adding a new source

Implement `VideoSource` (`src/sources/types.ts`) in a new `src/sources/<name>/` folder, then add
one line to `SOURCE_REGISTRY` in `src/sources/registry.ts`. If the platform doesn't allow
downloading video, still implement discovery/metadata and have `getVideoSource` return
`{ downloadable: false, reason: "..." }` — the moment still shows up with its original timestamps
and source link, it just won't get a 9:16 export.
