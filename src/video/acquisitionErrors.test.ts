import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySpawnError, classifyYtDlpStderr } from "./acquisitionErrors";

// Real yt-dlp stderr fixtures (trimmed) for the failure modes this app has
// actually hit in production on Railway — see the PR that added this file.
const FIXTURES = {
  rateLimited: `
[youtube] dQw4w9WgXcQ: Downloading webpage
ERROR: [youtube] dQw4w9WgXcQ: Unable to download webpage: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: 'Too Many Requests'>)
`,
  botCheck: `
[youtube] dQw4w9WgXcQ: Downloading webpage
ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.
`,
  loginRequired: `
ERROR: [youtube] abc123: Private video. Sign in if you've been granted access to this video
LOGIN_REQUIRED
`,
  jsRuntimeMissing: `
ERROR: [youtube] dQw4w9WgXcQ: No supported JavaScript runtime could be found. See  https://github.com/yt-dlp/yt-dlp#js-runtimes  for more info
`,
  genericFailure: `
ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed by the uploader
`,
};

test("classifyYtDlpStderr: HTTP 429 is rate_limited and access-blocked", () => {
  const result = classifyYtDlpStderr(FIXTURES.rateLimited);
  assert.equal(result.kind, "rate_limited");
  assert.equal(result.isAccessBlocked, true);
});

test("classifyYtDlpStderr: bot-check challenge is bot_check and access-blocked", () => {
  const result = classifyYtDlpStderr(FIXTURES.botCheck);
  assert.equal(result.kind, "bot_check");
  assert.equal(result.isAccessBlocked, true);
});

test("classifyYtDlpStderr: LOGIN_REQUIRED is login_required and access-blocked", () => {
  const result = classifyYtDlpStderr(FIXTURES.loginRequired);
  assert.equal(result.kind, "login_required");
  assert.equal(result.isAccessBlocked, true);
});

test("classifyYtDlpStderr: an unrelated video-unavailable error is unknown, not access-blocked", () => {
  const result = classifyYtDlpStderr(FIXTURES.genericFailure);
  assert.equal(result.kind, "unknown");
  assert.equal(result.isAccessBlocked, false);
});

test("classifyYtDlpStderr: missing JS runtime message is unknown (not a block), so it doesn't trigger cooldown", () => {
  // This one is an environment misconfiguration (see --js-runtimes node),
  // not YouTube blocking us — must not be treated as isAccessBlocked, or a
  // broken deploy would look like it's in a YouTube-imposed cooldown.
  const result = classifyYtDlpStderr(FIXTURES.jsRuntimeMissing);
  assert.equal(result.isAccessBlocked, false);
});

test("classifySpawnError: ENOENT on yt-dlp is binary_missing, not access-blocked", () => {
  const err = Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
  const result = classifySpawnError(err, "yt-dlp");
  assert.equal(result.kind, "binary_missing");
  assert.equal(result.isAccessBlocked, false);
});

test("classifySpawnError: ENOENT on ffmpeg is ffmpeg_missing, not access-blocked", () => {
  const err = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
  const result = classifySpawnError(err, "ffmpeg");
  assert.equal(result.kind, "ffmpeg_missing");
  assert.equal(result.isAccessBlocked, false);
});

test("classifySpawnError: a non-ENOENT spawn error is unknown", () => {
  const err = Object.assign(new Error("spawn yt-dlp EACCES"), { code: "EACCES" });
  const result = classifySpawnError(err, "yt-dlp");
  assert.equal(result.kind, "unknown");
});
