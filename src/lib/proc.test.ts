import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, ProcessError } from "./proc";
import { classifySpawnError, classifyYtDlpStderr, isErrnoException } from "@/video/acquisitionErrors";

async function makeFakeScript(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "proc-test-"));
  const scriptPath = path.join(dir, "fake-binary.sh");
  await writeFile(scriptPath, `#!/bin/sh\n${body}\n`);
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test("run(): a successful process resolves with its stdout — proxy for a successful yt-dlp download", async () => {
  const script = await makeFakeScript('echo "download complete"; exit 0');
  const result = await run(script, []);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /download complete/);
});

test("run(): a nonexistent binary rejects with an ENOENT error, classified as binary_missing", async () => {
  await assert.rejects(
    () => run("/definitely/not/a/real/binary/yt-dlp", ["--version"]),
    (err: unknown) => {
      assert.ok(isErrnoException(err));
      assert.equal(err.code, "ENOENT");
      const classified = classifySpawnError(err, "yt-dlp");
      assert.equal(classified.kind, "binary_missing");
      assert.equal(classified.isAccessBlocked, false);
      return true;
    },
  );
});

test("run(): a nonexistent ffmpeg binary is classified as ffmpeg_missing", async () => {
  await assert.rejects(
    () => run("/definitely/not/a/real/binary/ffmpeg", ["-version"]),
    (err: unknown) => {
      assert.ok(isErrnoException(err));
      const classified = classifySpawnError(err, "ffmpeg");
      assert.equal(classified.kind, "ffmpeg_missing");
      return true;
    },
  );
});

test("run(): a non-zero exit rejects with ProcessError carrying real stderr, classified as rate_limited on 429", async () => {
  const script = await makeFakeScript(
    'echo "ERROR: [youtube] abc123: Unable to download webpage: HTTP Error 429: Too Many Requests" 1>&2; exit 1',
  );
  await assert.rejects(
    () => run(script, []),
    (err: unknown) => {
      assert.ok(err instanceof ProcessError);
      assert.equal(err.result.code, 1);
      const classified = classifyYtDlpStderr(err.result.stderr);
      assert.equal(classified.kind, "rate_limited");
      assert.equal(classified.isAccessBlocked, true);
      return true;
    },
  );
});
