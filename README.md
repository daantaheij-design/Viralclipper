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
    providers/claude.ts  Structured-output Claude vision calls (Zod schema, forced JSON) — the
                         ONLY place this app ever calls Anthropic, and so the single enforcement
                         point for the budget gate below
    budget.ts              Atomic AI-spend reservation (Postgres advisory lock) — the hard
                            daily/per-run/concurrency spending gate; see "Cost control" below
    pricing.ts            Approximate $/token pricing + pessimistic pre-call cost estimation
    costTracking.ts        Records every AI call as an ApiUsage row (confirmed spend)
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
    sourceCleanliness.ts     Zero-Anthropic local gate: ffmpeg + pixel-level heuristics reject
                              caption-heavy/overlay-heavy/split-screen sources before any AI cost
    quickScan.ts             Pass 1: sparse whole-video scan -> generously padded candidate windows
    detailedAnalysis.ts       Pass 2: dense scan of one window -> moment + scores + subject bboxes
    schemas.ts                 Zod schemas shared by both passes
  scoring/viralScore.ts      0-100 viral score = mean of the 11 sub-scores
  jobs/
    discovery.ts / analysis.ts / processing.ts   One job per pipeline stage, persistence-aware,
                                                  each DB-locked against overlapping concurrent runs
    pipeline.ts                                    Runs all three stages end to end
  worker/
    index.ts                 Long-running scheduler (node-cron) — the primary driver
    runOnce.ts                 One-shot pipeline run (`npm run worker:once`)
  database/               Prisma client, typed settings store, moment queries
    acquisitionCooldown.ts   Exponential backoff for a source that's actively blocking us
    jobLock.ts                 DB-backed mutex (atomic UPDATE...RETURNING) — one discovery run
                                and one analysis batch at a time, across web + worker + replicas
  storage/                Where rendered clips live — local disk or S3-compatible object
                           storage (index.ts picks the backend; see "Deploying to Railway")
  app/                    Next.js dashboard (App Router) + JSON API routes
```

### Pipeline

```
DISCOVERY -> DEDUP -> METADATA FILTER -> CHEAP CATEGORY PREFILTER (metadata only, zero cost)
  -> LOCAL SOURCE CLEANLINESS SCAN (ffmpeg + pixel heuristics, zero Anthropic cost)
       -> DIRTY?  YES -> DIRTY_LEAD (kept as a lead, never sent to Anthropic)
                  NO  -> continue
  -> PRIORITY RANKING (raw footage boosted, reposts/reaction/compilation formats deprioritized)
  -> AI BUDGET CHECK (atomic reservation — daily + per-run + concurrency, see below)
  -> QUICK CLAUDE SCAN (analysis/quickScan.ts, sparse frames)
  -> DETAILED CLAUDE ANALYSIS (analysis/detailedAnalysis.ts, dense frames on flagged windows only)
  -> VIRAL SCORE (scoring/viralScore.ts)
  -> 9:16 RENDER (video/renderVertical.ts, only for moments above the threshold)
  -> DASHBOARD
```

Anthropic is deliberately one of the **last**, most gated steps — not an early filter. See "Cost
control" below for the full picture (this is a hard spending gate, not just a soft budget check).

### Cost control: Anthropic is one of the last, most gated steps

This exists because of a real production incident: a $5 Anthropic top-up was burned through in a
single day. The cause was three compounding gaps, all fixed here — Claude was spending money on
videos that were locally, cheaply, obviously unusable (caption-heavy edited Shorts, arrow/circle
overlays — the actual moment could be genuinely good and Claude would still analyze the dirty
source anyway); the daily budget check was a soft pre-check (`spent < budget`), not an atomic
reservation, so nothing stopped several jobs/processes from each seeing "budget still OK" and all
proceeding at once; and a large discovery backlog had no cap translating it into a bounded number
of Claude calls.

- **Local, zero-Anthropic gates run first.** `src/discovery/categoryPrefilter.ts` scores metadata
  relevance and hard-rejects obviously-wrong topics (aviation, gaming, politics, podcasts,
  workplace/customer-service/relationship/courtroom arguments) at discovery time, before
  acquisition. `src/analysis/sourceCleanliness.ts` scores actual sampled frames (after
  acquisition, still zero Anthropic cost) for burned-in captions, arrow/circle/graphic overlays,
  and split-screen/reaction layouts — see its module docstring for exactly how (ffmpeg raw-frame
  sampling + a grid-based sharp-and-static heuristic, no OpenCV/ML dependency). Both gates are
  configurable thresholds in Settings (`minPreCategoryRelevanceScore`, `minSourceCleanlinessScore`
  — default 70/75). A video that fails the cleanliness gate becomes `dirty_lead` (never
  `filtered_out`/discarded): its score/flags/reason are persisted, plus
  `suggestCleanSourceQueries()` — pure string suggestions for a cleaner version of the same
  incident (no discovery API calls made automatically; that's a deliberate scope boundary for this
  PR, not an oversight — see the funnel dashboard to review dirty leads yourself).
- **Free local filtering throughput is completely decoupled from paid Anthropic throughput.**
  `src/jobs/analysis.ts::runAnalysis` runs two independent batches per tick: a FREE batch (up to
  `freeLocalFilterBatchSize`, default 25 — acquisition + the cleanliness scan above, zero Anthropic
  cost) that drains the discovery backlog into `dirty_lead` or `waiting_for_ai`, then — only if
  Paid AI Analysis is on — a PAID batch (up to `maxQuickScansPerRun`, default 1) that picks up
  `waiting_for_ai` candidates for an actual Claude quick scan. `maxQuickScansPerRun` governs *only*
  the second batch; it must never be used to cap the first (a production bug this fixed — the free
  batch was wrongly reusing that same setting, so local filtering ran at 1 video per 5-minute tick
  instead of the size the backlog actually needed). `waiting_for_ai` is deliberately the resting
  state for *any* candidate that's passed every free gate, whether or not AI is currently
  available — it's not just what a budget block produces.
- **The hard AI budget gate is atomic, not a soft pre-check.** `src/ai/budget.ts::reserveAiBudget`
  is called from exactly one place — `analyzeFrames` (`src/ai/providers/claude.ts`), the *only*
  place this app ever calls the Anthropic API — immediately before every request, and is the only
  place that may create/settle a reservation. It runs inside a Postgres transaction holding
  `pg_advisory_xact_lock`, so concurrent attempts from different processes (web + worker, or
  multiple worker replicas) are genuinely serialized, not racing an in-memory counter: each
  checks confirmed spend (today, from `ApiUsage`) + in-flight reserved spend + this call's
  pessimistic pre-call cost estimate against the daily budget, the per-run budget, and the max
  concurrent calls setting, before ever inserting a reservation row. A blocked call throws
  `AiBudgetBlockedError` — callers must handle it explicitly (`instanceof`), never let it fall into
  generic error handling — and no reservation, no ApiUsage row, and no Anthropic request happens.
  After a real call, `commitReservation` reconciles the reservation with the actual token
  usage/cost; on failure, `releaseReservation` frees it immediately. An abandoned reservation
  (crashed process) stops counting after 10 minutes.
- **`Paid AI Analysis` is a global kill switch** (`DiscoverySettings.paidAiAnalysisEnabled`,
  defaults **OFF**) checked first, before the budget math — when off, `reserveAiBudget` blocks
  every call unconditionally, from the worker, "Run discovery now", "Analyze Again", retries, and
  source repair alike, since they all funnel through the same `analyzeFrames`. Discovery and every
  local/free gate still run normally — only the Anthropic call itself is blocked.
- **A missing `ANTHROPIC_API_KEY` doesn't retry-loop.** `reserveAiBudget` checks for the key before
  ever attempting a call and blocks with `no_api_key`; `jobs/analysis.ts` turns that into a
  `waiting_for_ai` `SourceVideo` status (not `error`) — the queue stays stable instead of failing
  the same jobs every worker tick, and once the key is set and Paid AI Analysis is turned on,
  eligible videos resume from there (cheap steps like acquisition/cleanliness redo; no Anthropic
  cost was ever incurred, so there's nothing to resume from a checkpoint).
- **One discovery run, one analysis batch, at a time.** `src/database/jobLock.ts` is a DB-backed
  mutex (atomic `UPDATE ... WHERE ... RETURNING` compare-and-swap, no advisory lock needed since a
  single SQL statement is already atomic) — `jobs/discovery.ts` and `jobs/analysis.ts` each take
  their own named lock, so a worker tick can never overlap a manually-triggered run, and clicking
  "Run discovery now" three times starts exactly one run (`POST /api/discovery/run` now awaits
  discovery itself — a bounded number of search-API calls — so it can answer
  `DISCOVERY_ALREADY_RUNNING` (409) synchronously and correctly for a duplicate click; analysis and
  rendering, the genuinely multi-minute stages, still run in the background afterward). A lock held
  past 30 minutes (a crashed holder) is treated as abandoned and can be reclaimed.
- **The Settings/cost dashboard is the source of truth**, not just a display: it shows the full
  discovery funnel (discovered → rejected by metadata/category/dirty-source → pending local
  filtering → clean candidates/waiting for AI → sent to Anthropic → detailed analyses → good
  moments), confirmed vs. reserved/in-flight spend, remaining budget, and a prominent
  `AI BUDGET REACHED — PAID ANALYSIS PAUSED` banner at 100%. Every funnel number is a real database
  status count (`GET /api/stats`), never a client-side estimate. Local ffmpeg/CV processing cost is
  never mixed into the Anthropic spend numbers (local gates never write an `ApiUsage` row).

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

### Missing media & the "Re-render 9:16" repair flow

A `TikTokVersion` row saying `ready` is not, by itself, proof that the rendered file still exists
— most notably, any clip rendered before the S3-compatible storage bucket was configured only ever
lived on a container's ephemeral disk and was lost on the next redeploy. Rather than trust the
stored status, the app verifies and repairs:

- **`StorageBackend.exists(key)`** (`src/storage/types.ts`, implemented by both `local.ts` and
  `s3.ts`) is a cheap existence check independent of `resolve()` (which returns a *playable* URL).
  `GET /api/media/[momentId]` already resolved lazily and 404s if the object is gone — that part
  needed no changes.
- **`src/database/renderVerification.ts::healStaleReadyStatuses`** runs on every moment list/detail
  fetch (`listMoments`/`getMomentById` in `src/database/moments.ts`): for each `ready` clip it
  checks `storage.exists()` and, if the object is actually missing, flips that `TikTokVersion` to
  the `media_missing` status (a dedicated `TikTokVersionStatus` value) and persists it — read-repair,
  not a background job. `DetectedMoment.status` itself is left untouched (still `ready`/visible on
  the dashboard) — only the render is affected. Fails open on a transient storage error so a real
  outage doesn't make working clips look broken.
- **`src/jobs/renderCore.ts::performRenderAndUpload`** is the single render+upload+verify path used
  by both the automatic pipeline (`jobs/processing.ts`) and manual repair (`jobs/rerender.ts`) — a
  clip is only marked `ready` after render, upload, *and* a post-upload `storage.exists()` check all
  succeed. If the upload call reports success but the object can't be verified afterward, the
  result is `media_missing`, never `ready` — this is exactly how the original bug happened (a
  successful-looking upload that only wrote to disk that later disappeared), so it's never trusted
  on its own again.
- **`src/jobs/rerender.ts::repairRender`** is the manual "Re-render 9:16" entry point
  (`POST /api/moments/[id]/rerender`, awaited, no polling needed for a single clip) — it re-uses
  every already-persisted analysis field (timestamps, category, viral score, tracked subject
  keyframes) and re-runs only the technical steps (re-acquire source video if needed, ffmpeg
  render, bucket upload, existence verification). **It never calls Claude or re-runs
  discovery/quick-scan/detailed-analysis** — no extra Anthropic cost for a repair. Logs a
  `[repair] ...` narrative at each stage for production debugging.
- The dashboard (`ClipCard.tsx`) shows a `RENDER MISSING`/`RENDER FAILED` badge and a "Re-render
  9:16" button instead of ever claiming a clip is ready when it isn't; the preview player
  (`VerticalPlayer.tsx`) has explicit states (loading/ready/media missing/render failed/source
  unavailable — see `src/lib/playerState.ts`) instead of hanging on "Loading" forever, and falls
  back to the missing-media state itself if a `ready`-looking video actually fails to play
  (`<video onError>`), not just when the stored status already says so.

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
`railway.json` that declares the **build** (`builder: DOCKERFILE`) plus one `deploy` field:
`preDeployCommand: ["npx prisma migrate deploy"]`. Railway applies `railway.json` as a default to
every service deployed from this repo, and per-service fields committed there (like most of
`deploy.*`) end up applying to *all* of them, including a worker with no HTTP server to
health-check — which is why **Start Command** and **Healthcheck Path** are deliberately *not* in
`railway.json` and instead live in each service's own Settings in the Railway dashboard, which
always take priority over `railway.json`. `preDeployCommand` is the one exception, committed
on purpose: unlike a healthcheck path, "run pending migrations before starting" is correct for
*every* service, so it runs once per deploy — before the start command, using that same build —
for both web and worker automatically, without relying on either service's Start Command string
to remember to do it. This closes a real failure mode: a Start Command that's missing
`npx prisma migrate deploy &&` (whether never set that way, or edited/reset later) previously meant
a service could boot against a database schema older than what Prisma's client expects — exactly
what happened in production when `source_videos.accessFailureCount` was queried before its
migration had ever been applied. Do not remove `preDeployCommand`, and do not add
`startCommand`/`healthcheckPath` back to `railway.json` — that's the healthcheck bleed-through this
section fixes, and per-service Settings remain the right place for those two.

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

The `npx prisma migrate deploy &&` prefix in both Start Commands above is now redundant with
`railway.json`'s `preDeployCommand` (migrations already ran once, successfully, before either
service's start command executes) — harmless to keep since `prisma migrate deploy` is idempotent,
but the point is migrations no longer *depend* on that prefix being present.

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

A fresh database's `Settings` start out deliberately narrow and, as of the cost-control PR,
**both automatic discovery and Paid AI Analysis start OFF** (`src/database/settings.ts`
`DEFAULT_SETTINGS`) — nothing spends Anthropic money until you explicitly turn it on:

- **Automatic discovery: OFF.** **Paid AI Analysis: OFF** (the global kill switch — see "Cost
  control" above). Both need a manual flip in Settings.
- Source: **YouTube only** (Reddit seeded as disabled). Category: **Road Rage only**.
- Daily Anthropic budget: **$0.50**. Per-run Anthropic budget: **$0.20**. Max concurrent
  Anthropic calls: **1**.
- Candidates per discovery run: **20**. Quick scans / detailed analyses / 9:16 renders per run:
  **1** each.
- Min source cleanliness score: **75**. Min pre-category relevance score: **70**.

With discovery off, nothing happens until you either click **Run discovery now** (still safe —
Paid AI Analysis stays off, so discovery/local filtering runs but zero Anthropic calls happen) or
turn automatic discovery on. Once you've watched a few discovery runs populate the funnel on the
Settings page (discovered → rejected by category/dirty-source → clean candidates) and you're
ready to spend, turn **Paid AI Analysis** on — that's the one switch that actually allows an
Anthropic call anywhere in the app. Raise the tiny per-run/daily budgets only after you've watched
a real quick scan's actual cost land on the dashboard.

That's the whole pipeline exercised end to end — YouTube search → local category/cleanliness
gates → download (yt-dlp) → frame extraction (ffmpeg) → Claude vision (quick scan, then detailed
analysis, budget-gated) → start/peak/end timestamps + viral score → smart-cropped ffmpeg 9:16
render → visible on the dashboard — without risking a large AI/API bill on the first deploy.

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

`npm test` runs with `--test-concurrency=1` (see `package.json`) — deliberate, not accidental:
node's test runner can execute multiple test files' top-level code concurrently within one
process, and several files here mutate real, genuinely shared state (the single
`discovery_settings` Postgres row via `updateSettings`, and in one budget test,
`env.anthropicApiKey`) — running them concurrently produced real, reproducible cross-file test
failures (one file's settings write landing mid-flight in another file's assertion). Don't remove
this flag for speed without re-verifying the full suite passes repeatedly first.

`src/analysis/sourceCleanliness.test.ts` and `src/analysis/quickScan.test.ts` **are** a real
ffmpeg synthetic-video integration suite (no OpenCV/ML dependency; see
`sourceCleanliness.ts`'s module docstring): frame content is generated pixel-by-pixel with a
seeded PRNG rather than an ffmpeg `lavfi` source like `testsrc`/`mandelbrot`/`gradients` — all
three turned out to have their own static calibration regions or non-reproducible-per-run content
that produced flaky or misleading results when tried here, so don't reach for them as a shortcut
without re-verifying determinism first. `src/ai/budget.test.ts` and `src/database/jobLock.test.ts`
exercise real concurrent Postgres transactions (`Promise.all` racing several reservation/lock
attempts) — per the cost-control PR's explicit requirement, the budget transaction logic is never
mocked in these tests.

`video/renderVertical.ts`'s actual ffmpeg filter-graph output should be spot-checked against a
real clip before relying on it, the same way `smartCrop.ts`'s pan math should be sanity-checked
against a real moment with two tracked
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
