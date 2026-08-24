import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export class ProcessError extends Error {
  constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly result: RunResult,
  ) {
    super(
      `${command} ${args.join(" ")} exited with code ${result.code}: ${result.stderr.slice(-2000)}`,
    );
    this.name = "ProcessError";
  }
}

/** Runs an external binary and rejects with ProcessError on non-zero exit. */
export function run(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result: RunResult = { stdout, stderr, code };
      if (code === 0) resolve(result);
      else reject(new ProcessError(command, args, result));
    });
  });
}
