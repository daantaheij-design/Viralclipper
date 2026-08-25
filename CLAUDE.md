@AGENTS.md

# CLAUDE.md

Guidance for a future Claude Code session working in this repository. Read `README.md` first for
the product/architecture overview — this file is conventions and gotchas that aren't obvious from
the code.

## What this is

An automatic viral-clip discovery tool (see README.md for the full pipeline). It is NOT an
upload-first video editor — the default experience is an already-populated dashboard, driven by a
background `worker` process. Do not add an "upload video" flow as the primary entry point; manual
URL import, if ever added, is explicitly a secondary tool per the product brief.

## Conventions

- **Every AI vision call goes through `src/ai/providers/claude.ts::analyzeFrames`.** It forces
  structured output via `output_config.format` + a Zod schema (not tool-use forcing, not prose
  parsing) and records cost to `ApiUsage` on every call. Never call the Anthropic SDK directly
  from `analysis/`. This is also the single enforcement point for the hard AI-spend gate — see the
  next bullet — so this rule doubles as "never bypass the budget gate," not just a style
  preference.
- **The AI budget gate (`src/ai/budget.ts::reserveAiBudget`) is atomic and must never be
  bypassed, softened, or duplicated.** It's called from exactly one place — inside `analyzeFrames`,
  immediately before the Anthropic request — inside a Postgres transaction holding
  `pg_advisory_xact_lock` so concurrent processes (web + worker, multiple worker replicas) can't
  race past the daily/per-run/concurrency limits. A blocked call throws `AiBudgetBlockedError`;
  catch it explicitly (`instanceof`) wherever you call `runQuickScan`/`runDetailedAnalysis` —
  never let it fall into a generic catch that treats it like an ordinary failure (that's exactly
  what turns a budget block into a `waiting_for_ai` `SourceVideo` status instead of an `error`
  that never retries once conditions change). Do not add a second place that checks
  `settings.paidAiAnalysisEnabled`/budget and decides to call Anthropic anyway — every caller must
  go through `analyzeFrames`, full stop. This exists because of a real production incident (a $5
  Anthropic top-up burned through in a day, no atomic cap enforcing the daily budget) — see
  README's "Cost control" section before touching any of `src/ai/budget.ts`,
  `src/ai/providers/claude.ts`, or the `AiSpendReservation` model.
- **The local, zero-Anthropic gates run before acquisition/analysis ever gets a chance to spend
  anything.** `src/discovery/categoryPrefilter.ts` (discovery time, metadata only) and
  `src/analysis/sourceCleanliness.ts` (after acquisition, real sampled frames, still zero
  Anthropic cost) must both run — and must both keep passing their own "never imports `@/ai/`"
  structural test — before `jobs/analysis.ts` ever calls `runQuickScan`. If you touch the pipeline
  order in `jobs/analysis.ts` or `src/discovery/runDiscovery.ts`, keep `jobs/analysis.test.ts`'s
  structural ordering assertion (`scanSourceCleanliness(...)` appears before `runQuickScan(...)`
  in the source text) meaningful, not just passing by coincidence.
- **`jobs/analysis.ts` runs two independently-batched stages — never let one setting govern
  both again.** `runFreeLocalFilteringBatch` (acquisition + cleanliness scan, zero Anthropic cost)
  is bounded by `settings.freeLocalFilterBatchSize`; `runPaidAnthropicBatch` (the actual quick-scan
  Anthropic calls, reading only `status: "waiting_for_ai"` candidates) is bounded by
  `settings.maxQuickScansPerRun`. This split exists because of a real production bug: the free
  batch was reusing `maxQuickScansPerRun` (default 1), so a several-hundred-video backlog drained
  at one video per 5-minute worker tick even with Paid AI Analysis off and nothing costing money.
  If you touch either query, keep them on separate settings — `jobs/analysis.test.ts` has a
  structural test asserting `runFreeLocalFilteringBatch`'s own source text never references
  `maxQuickScansPerRun`.
- **The Claude model is read from `CLAUDE_MODEL`** (`src/lib/env.ts`, default `claude-opus-5`) —
  never hardcode a model string elsewhere. Same for `YOUTUBE_API_KEY`/Reddit credentials via
  `src/lib/env.ts`'s `require*` helpers, which throw a clear error rather than silently no-op.
- **`OBSERVABLE_ONLY_RULE` in `src/analysis/schemas.ts`** must stay baked into both quick-scan and
  detailed-analysis system prompts if you touch them — moment descriptions must describe only
  what's visible, never assert intent/motive.
- **No creative editing in the render path, ever.** `video/renderVertical.ts` does crop+scale+trim
  and nothing else. If a future request asks for captions/music/voice-over/overlays, that is a
  deliberate scope change from the product brief — confirm with the user before adding it, don't
  just bolt it onto this renderer.
- **`src/sources/registry.ts` is the only place discovery/analysis code should look up a source.**
  Never import `youtube/index.ts` or `reddit/index.ts` directly outside of `src/sources/`.
- **Resumability:** `SourceVideo.status` and `DetectedMoment.status`/`TikTokVersion.status` are
  the checkpoints. `jobs/analysis.ts` and `jobs/processing.ts` only pick up videos/moments in the
  right status, so a worker restart mid-run doesn't redo already-finished (paid) AI work — keep
  that property if you touch those job files. `DetectedMoment.trackedKeyframes` is persisted
  specifically so a render retry never needs another Claude call to re-derive the crop path.
- **Every job/render step wraps its own try/catch and writes to `ErrorLog`/`*.errorMessage`**
  (`src/lib/errorLog.ts`) rather than throwing out of the pipeline — one bad video must never stop
  the rest of a discovery/analysis run. Preserve that per-item isolation if you restructure
  `jobs/analysis.ts` or `jobs/processing.ts`.
- **`jobs/analysis.ts` and `jobs/processing.ts` must always fetch video bytes via
  `src/video/acquire.ts::acquireVideo()`, never `ytdlp.ts::downloadVideo()` directly.** That's
  what applies pacing (`acquisitionThrottle.ts`) and turns a raw yt-dlp failure into a classified
  `AcquisitionError` (`acquisitionErrors.ts`) the job loop can branch on — a 429/bot-check/
  login-required must become `source_access_blocked` + a cooldown
  (`database/acquisitionCooldown.ts`), never an ordinary retry-next-tick `error`. See README's
  "Media acquisition" section for the full story; this is a production-observed failure mode
  (Railway's IP getting rate-limited/challenged by YouTube), not speculative hardening — don't
  relax it without re-reading why it's there.
- **Never assume yt-dlp will work.** Any change that adds a new place video bytes are fetched from
  a yt-dlp-backed source must go through `acquire.ts`, and must handle `AcquisitionError` the same
  way the existing job loops do (blocked → cooldown + move on; missing binary → abort the run,
  don't burn through the rest of the batch identically failing).

## Stack-specific gotchas

- **Prisma is deliberately pinned to v6** (`prisma-client-js` generator), not v7. Prisma 7 removed
  inline `datasource.url` and requires a driver-adapter passed to the `PrismaClient` constructor —
  more moving parts than this project needs. Don't "upgrade" to v7 without a real reason; if you
  do, you'll need to rewrite `src/database/client.ts` around an adapter.
- **Next.js 16 renamed `middleware.ts` → `src/proxy.ts`** (function name `proxy`, not
  `middleware`). This project's auth gate lives there. The bundled per-version docs at
  `node_modules/next/dist/docs/` are authoritative over training-data assumptions about Next.js —
  re-read the relevant guide there before making App Router changes; conventions (async
  `params`/`searchParams`, route handler signatures, etc.) have moved around across versions.
- **The login page (`src/app/login/`) is deliberately outside the `(dashboard)` route group** so
  it doesn't get the nav sidebar. Any new top-level page that should show the sidebar goes inside
  `src/app/(dashboard)/`.
- **List pages (`MomentFeed.tsx`) fetch client-side**, not via server-component data fetching —
  this keeps filter/sort state in the URL via `useSearchParams`/`router.replace` without a full
  page reload, and keeps action buttons (save/reject/etc.) optimistic (remove-from-list on
  success) without juggling server-action revalidation. Follow that pattern for new list views
  rather than mixing in server-fetched data for the same list.
- **`eslint-plugin-react-hooks`'s newer rules (`set-state-in-effect`, `purity`) are strict** about
  fetch-on-mount patterns and calling `Date.now()`/similar in non-obviously-event-handler
  functions. The existing suppressions in `MomentFeed.tsx`/`SourcesPanel.tsx` are deliberate, not
  oversights — prefer restructuring to avoid the impure call (see `SettingsForm.tsx`'s `saved`
  boolean instead of a `Date.now()` timestamp) over blanket-disabling the rule.
- **`tsx` and `prisma` (the CLI) live in `dependencies`, not `devDependencies`**, even though
  they're normally dev tools — the worker service in production runs `tsx src/worker/index.ts`
  directly (no bundling step for the worker, unlike the web app which `next build` compiles), and
  both services' Railway start commands run `npx prisma migrate deploy`. Don't move them back
  without also changing how the worker runs in production.
- **`DEFAULT_SETTINGS` in `src/database/settings.ts` and `seedSources()` in `src/database/seed.ts`
  are deliberately conservative** (YouTube only, Road Rage only, small per-run caps, automatic
  discovery OFF, **Paid AI Analysis OFF**, a $0.50 daily / $0.20 per-run Anthropic budget) — that's
  the safe first-deploy configuration, not a permanent product decision. For a *fresh* database
  (no `AppSetting` row yet) these are just the code-level defaults; for an *existing* installation
  that already has a `discovery_settings` row, the `ai_cost_control` migration additionally
  force-overwrites the automatic-discovery toggle, Paid AI Analysis, and every numeric cap to
  these same safe values via a one-time `UPDATE` — see that migration's SQL and its comment before
  assuming "only affects fresh installs" is still true; it was a deliberate exception for this one
  migration given what caused it (see README's "Cost control"). Raise the numbers from the
  Settings page after a real deployment has been verified end to end and you've decided to spend —
  never by editing these defaults, and never automatically as part of a future migration/deploy.
- **Two DB-backed job locks (`src/database/jobLock.ts`) — `"discovery"` and `"analysis"`** — must
  keep guarding `jobs/discovery.ts::runDiscoveryJob` and `jobs/analysis.ts::runAnalysis`
  respectively. They're what makes triple-clicking "Run discovery now" (or a worker tick racing a
  manual trigger) produce one real run instead of duplicates. If you add another entry point that
  can trigger discovery or analysis, route it through those same functions rather than calling
  `discovery/runDiscovery.ts::runDiscovery()` or the analysis internals directly — bypassing them
  reintroduces the exact race this exists to prevent.

## Local development

```bash
npm install
cp .env.example .env   # at minimum DATABASE_URL; see README.md for the rest
npm run db:migrate     # or `npx prisma migrate deploy` against an existing database
npm run db:seed
npm run dev             # dashboard
npm run worker           # background pipeline — run alongside dev in a second terminal
```

`ffmpeg`/`ffprobe`/`yt-dlp` must be on `PATH` for the video pipeline to do anything real — without
them, discovery/dedup/scoring/the dashboard all still work, but analysis jobs will fail once they
reach frame extraction. That's expected in an environment without those binaries (this project was
built in one) — verify the video pipeline for real before relying on it.

## Testing

```bash
npm run typecheck
npx eslint .
npm test          # node:test via tsx — no framework dependency, see package.json
npm run build
```

`npm test` runs `tsx --test src/**/*.test.ts` — Node's built-in test runner, chosen specifically
to avoid adding a test-framework dependency (`tsx` was already a dependency for the worker). Keep
new tests colocated as `<name>.test.ts` next to the code they cover, matching
`src/video/acquisitionErrors.test.ts` / `src/lib/proc.test.ts` / etc. Prefer pure functions you
can unit-test directly (like `classifyYtDlpStderr`) over mocking; where a real child process is
cheap and deterministic (like `proc.test.ts` does with tiny fake shell scripts), exercise it for
real rather than mocking `child_process`. Follow the existing project's lead (`road-rage-clipper`,
a sibling project) of mocking external APIs (Anthropic/YouTube/Reddit HTTP calls) in any future
HTTP-layer tests and only running real ffmpeg for filter-graph-correctness tests — never call paid
APIs from tests.

## Deployment

`Dockerfile` + `railway.json` are Railway-specific but generic enough to adapt to any container
platform — see README.md's "Deploying to Railway" section for the full walkthrough. Two things
worth knowing before touching either file:

- **`railway.json`'s `deploy` section is intentionally limited to `preDeployCommand`.** It used to
  also carry start command / health check path, but Railway applies the root `railway.json` as a
  default to every service deployed from this repo — so a `deploy.healthcheckPath` there was
  reaching the worker service too, which has no HTTP server and would fail that check. Start
  Command and Healthcheck Path stay in each Railway service's own dashboard Settings (which always
  override `railway.json`) — do not put those two fields back in the committed file, and do not
  resurrect a second `railway.<service>.json` file pointed at via a per-service "config file path"
  (that override does not reliably isolate every field either, which is exactly what caused the
  original bleed-through).
- `deploy.preDeployCommand: ["npx prisma migrate deploy"]` is the one `deploy.*` field that
  deliberately *is* committed and shared by every service — unlike the healthcheck, running
  migrations before start is correct for **both** web and worker, so the same root-config
  bleed-through that broke the healthcheck is exactly what we want here. This exists because
  relying solely on each service's dashboard Start Command (e.g.
  `npx prisma migrate deploy && npm run start`) to apply migrations means a manually-edited or
  reset Start Command can silently skip them — which is what caused a real production outage
  (`source_videos.accessFailureCount` didn't exist because a pending migration was never applied).
  `preDeployCommand` runs once per deploy, before the start command, using the same build — so
  migrations are now guaranteed regardless of what a service's Start Command happens to be.
  `prisma migrate deploy` is idempotent, so it staying in a service's Start Command too is harmless
  redundancy, not a bug.
- Rendered clips go through a **Storage Bucket** (`src/storage/s3.ts`) rather than local disk once
  web and worker are separate containers, since Railway Volumes can't be attached to more than one
  service.

## Storage backends

`src/storage/index.ts` picks between `local.ts` (default) and `s3.ts` (whenever `S3_BUCKET` is
set) — that's the only place the choice is made; nothing else in the app should import
`local.ts`/`s3.ts` directly, or check `env.s3Bucket` itself. Both implement the same
`StorageBackend` interface (`src/storage/types.ts`): `upload`, `exists`, and `resolve` (which
returns either `{ type: "stream", path }` for the media route to stream itself, or
`{ type: "redirect", url }` — a presigned URL — for the route to 302 to). If you add a third
backend, it only needs to implement that interface; the render job (`jobs/processing.ts`) and the
media route (`app/api/media/[momentId]/route.ts`) don't change.

## Render status is verified, not just stored — the missing-media repair flow

A `TikTokVersion.status === "ready"` row is never trusted at face value; it means "the last render
we know about reported success", not "the file is definitely still there" (rendered-before-S3
clips that only ever lived on ephemeral container disk are the real production case this covers).
Two things enforce this and must stay in sync if you touch either:

- **`src/database/renderVerification.ts::healStaleReadyStatuses`** is called from both
  `listMoments()` and `getMomentById()` (`src/database/moments.ts`) — every `ready` clip gets a
  `storage.exists()` check on read, and a stale one is flipped to the `media_missing`
  `TikTokVersionStatus` right there (read-repair, no background job). It only ever touches
  `TikTokVersion.status`, never `DetectedMoment.status` — the moment must stay visible/browsable
  even when its render is broken, since that's what lets the dashboard badge and "Re-render 9:16"
  button reach it at all.
- **`src/jobs/renderCore.ts::performRenderAndUpload`** is the *only* render+upload path — both
  `jobs/processing.ts` (automatic) and `jobs/rerender.ts::repairRender` (manual "Re-render 9:16",
  `POST /api/moments/[id]/rerender`) call it, so a fix here can't drift between the two callers.
  It sets `status: "ready"` **only** after render, upload, *and* a post-upload
  `storage.exists()` re-check all succeed — an upload call returning success is never trusted on
  its own (that's exactly how the original bug happened). If verification fails after a
  successful-looking upload, the result is `media_missing`, never `ready`. Accepts an injectable
  `RenderDependencies` (`acquireVideo`/`probeVideo`/`renderVerticalClip`/`uploadToStorage`/
  `verifyStorageObjectExists`) purely so tests can fake the yt-dlp/ffmpeg/network parts while still
  exercising the real local storage backend — production code never passes `deps`.
- `repairRender` reuses every already-persisted analysis field (timestamps, category, viral score,
  `trackedKeyframes`) and **never calls Claude or re-runs discovery/quick-scan/detailed-analysis**
  — keep it that way if you touch it; a repair must never re-incur Anthropic cost. It logs a
  `[repair] ...` narrative via `performRenderAndUpload`'s `onStage` callback for production
  debugging — the automatic pipeline omits `onStage` (defaults to a no-op) so it doesn't gain the
  same log volume.
- `src/lib/playerState.ts::deriveRenderDisplayState` is the single source of truth both
  `ClipCard.tsx` (badge) and `VerticalPlayer.tsx` (player states + "Re-render 9:16" button) derive
  from a `TikTokVersionStatus` — keep new statuses (or new UI states) added there, not duplicated
  ad hoc in either component. `VerticalPlayer.tsx` additionally downgrades its own "ready" case to
  the `media_missing` display on a live `<video onError>` — the persisted status can still be
  stale between a read-repair check and an actual playback attempt.
