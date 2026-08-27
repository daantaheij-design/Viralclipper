-- One-time, safety-critical, CONDITIONAL data fix for a single real production
-- SourceVideo row (id = 'cmt8f9zz4006tla0e826t78b4') caught mid-processing by
-- the quick-scan multi-request incident this deployment fixes (see README's
-- "A fourth production incident" and prisma/schema.prisma's
-- ai_budget_exhausted doc comment).
--
-- What happened to this specific row, traced from the OLD (pre-fix) code:
-- its quick scan committed 2 real, paid Anthropic requests (~$1.10 total,
-- confirmed/committed in api_usage — untouched by this migration), then a
-- 3rd quick-scan request was correctly blocked by the daily budget. The OLD
-- jobs/analysis.ts caught that AiBudgetBlockedError and, because
-- paidAnalysisAttempts hadn't reached the retry cap yet, reverted this row's
-- status back to 'waiting_for_ai' — which, left as-is, would make it
-- eligible for paid selection again and re-incur the SAME ~$1.10 of
-- quick-scan cost a second time for zero new information the moment Paid AI
-- Analysis is next turned on, since nothing about quick scan's progress was
-- ever persisted under the old design.
--
-- This UPDATE is intentionally CONDITIONAL (only touches the row if it is
-- still exactly 'waiting_for_ai') rather than an unconditional overwrite:
-- this environment has no direct read access to production to confirm the
-- row's exact current status before writing this migration, and a
-- conditional guard makes the statement a safe no-op if the row has since
-- moved to some other status through any other path. It does NOT touch,
-- delete, or reset any other source_videos row, and it does NOT modify or
-- delete any api_usage row — the historical $1.1018 already spent on this
-- candidate is preserved exactly as recorded.
UPDATE "source_videos"
SET "status" = 'ai_budget_exhausted',
    "errorMessage" = 'Quick scan completed (cost committed) but the detailed-analysis budget reservation was blocked; protected from automatic re-processing by the fix in this deployment — see the ai_budget_exhausted migration.'
WHERE "id" = 'cmt8f9zz4006tla0e826t78b4'
  AND "status" = 'waiting_for_ai';
