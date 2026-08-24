export async function register() {
  // The self-test spawns child processes (yt-dlp/ffmpeg/node) — Node-only,
  // and instrumentation also loads under the Edge runtime where that isn't
  // available. The web service normally never touches yt-dlp itself
  // (that's the worker's job), but it can via "Run discovery now"
  // (POST /api/discovery/run), so it's worth knowing this environment's
  // video-pipeline health here too, not just in the worker.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartupSelfTest } = await import("@/lib/selfTest");
    await runStartupSelfTest();
  }
}
