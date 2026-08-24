import { run } from "./proc";
import { env } from "./env";

export interface SelfTestResult {
  nodeVersion: string;
  ytDlpVersion: string | null;
  ffmpegVersion: string | null;
  /**
   * Whether a `node` binary is resolvable on PATH in this container — the
   * same thing yt-dlp itself needs to find when given `--js-runtimes node`
   * (see video/ytdlp.ts). This is the closest network-free proxy for "will
   * yt-dlp's JS runtime detection succeed" without actually hitting
   * YouTube at every container boot, which would be its own way to look
   * like a bot.
   */
  nodeRecognizedByYtDlp: boolean;
}

async function firstLine(text: string): Promise<string> {
  return text.split("\n")[0]?.trim() ?? "";
}

/**
 * Logs the video-pipeline environment's health once at process startup —
 * yt-dlp/ffmpeg/Node versions and whether yt-dlp's JS runtime requirement
 * is satisfiable. Entirely version-string output, no network calls, no
 * secrets (never touches cookies — see video/ytdlpCookies.ts).
 */
export async function runStartupSelfTest(): Promise<SelfTestResult> {
  const nodeVersion = process.version;

  const ytDlpVersion = await run(env.ytDlpPath, ["--version"])
    .then((r) => r.stdout.trim())
    .catch(() => null);

  const ffmpegVersion = await run(env.ffmpegPath, ["-version"])
    .then((r) => firstLine(r.stdout))
    .catch(() => null);

  const nodeRecognizedByYtDlp = await run("node", ["--version"])
    .then(() => true)
    .catch(() => false);

  const result: SelfTestResult = { nodeVersion, ytDlpVersion, ffmpegVersion, nodeRecognizedByYtDlp };

  console.log(
    `[self-test] node=${nodeVersion} yt-dlp=${ytDlpVersion ?? "NOT FOUND"} ffmpeg=${ffmpegVersion ?? "NOT FOUND"} js-runtime-node-available=${nodeRecognizedByYtDlp}`,
  );
  if (!ytDlpVersion) {
    console.error("[self-test] yt-dlp is not on PATH — media acquisition will fail for every source");
  }
  if (!ffmpegVersion) {
    console.error("[self-test] ffmpeg is not on PATH — frame extraction and rendering will fail");
  }
  if (!nodeRecognizedByYtDlp) {
    console.error(
      "[self-test] node is not on PATH — yt-dlp --js-runtimes node will fail, YouTube downloads will likely error with 'No supported JavaScript runtime could be found'",
    );
  }

  return result;
}
