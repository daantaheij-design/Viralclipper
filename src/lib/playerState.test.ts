import { test } from "node:test";
import assert from "node:assert/strict";
import { canRerender, deriveRenderDisplayState, RENDER_STATE_MESSAGE } from "./playerState";

test("deriveRenderDisplayState: no TikTokVersion yet -> no_render, no re-render offered", () => {
  assert.equal(deriveRenderDisplayState(null), "no_render");
  assert.equal(deriveRenderDisplayState(undefined), "no_render");
  assert.equal(canRerender("no_render"), false);
});

test("deriveRenderDisplayState: queued/processing -> processing, no re-render offered mid-render", () => {
  assert.equal(deriveRenderDisplayState("queued"), "processing");
  assert.equal(deriveRenderDisplayState("processing"), "processing");
  assert.equal(canRerender("processing"), false);
});

test("deriveRenderDisplayState: ready -> attempting (player must try to actually play it)", () => {
  assert.equal(deriveRenderDisplayState("ready"), "attempting");
  assert.equal(canRerender("attempting"), false);
});

test("deriveRenderDisplayState: media_missing -> media_missing, with the exact 'no longer available' player copy and a re-render offer", () => {
  assert.equal(deriveRenderDisplayState("media_missing"), "media_missing");
  assert.equal(canRerender("media_missing"), true);
  assert.equal(RENDER_STATE_MESSAGE.media_missing, "This render is no longer available.");
});

test("deriveRenderDisplayState: failed -> render_failed, re-render offered", () => {
  assert.equal(deriveRenderDisplayState("failed"), "render_failed");
  assert.equal(canRerender("render_failed"), true);
});

test("deriveRenderDisplayState: unavailable -> source_unavailable, re-render offered", () => {
  assert.equal(deriveRenderDisplayState("unavailable"), "source_unavailable");
  assert.equal(canRerender("source_unavailable"), true);
});
