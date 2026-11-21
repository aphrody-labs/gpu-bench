// Shared helpers for scripts/run.ts and scripts/report.ts: paths, subprocesses, statistics, pins and machine facts.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const BIN = join(ROOT, ".bin");
export const RESULTS = join(ROOT, "results");
export const FR1_DIR = "~/gpu-bench/repo";

export const path = (...parts: string[]) => join(ROOT, ...parts);
export const ensureDir = (dir: string) => mkdirSync(dir, { recursive: true });
export const log = (message: string) => console.error(`[gpu-bench] ${message}`);

/** Runs a command, streams nothing, returns stdout; throws with stderr on failure. */
export async function capture(command: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  const child = Bun.spawn(command, { cwd: options.cwd ?? ROOT, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe" });
  const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (timer) clearTimeout(timer);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}\n${stderr.slice(-2000)}`);
  return stdout;
}

export const fr1 = (script: string, timeoutMs = 3_600_000) => capture(["ssh", "fr1", `export PATH=$HOME/.cargo/bin:$HOME/.bun/bin:$PATH XWIN_ACCEPT_LICENSE=1; ${script}`], { timeoutMs });

// ---- statistics -------------------------------------------------------------------------------------------------

export const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
/** Linear-interpolated percentile (the "R-7" definition used by numpy and Excel), p in [0, 100]. */
export function percentile(values: number[], p: number): number {
  const s = sorted(values);
  if (s.length === 0) return Number.NaN;
  const rank = (p / 100) * (s.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return s[lower]! + (s[upper]! - s[lower]!) * (rank - lower);
}
export const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
export const stdev = (values: number[]) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
};

export interface Summary {
  /** Number of samples pooled over every run. */
  samples: number;
  runs: number;
  p50: number;
  p95: number;
  p99: number;
  /** Across-run spread of the per-run medians. */
  medianOfRuns: number;
  min: number;
  max: number;
  stdev: number;
  /** Coefficient of variation of the per-run medians, in percent. */
  cv: number;
}

export function summarize(perRun: number[][]): Summary {
  const pooled = perRun.flat();
  const medians = perRun.filter((run) => run.length > 0).map((run) => percentile(run, 50));
  const m = mean(medians);
  return {
    samples: pooled.length,
    runs: medians.length,
    p50: percentile(pooled, 50),
    p95: percentile(pooled, 95),
    p99: percentile(pooled, 99),
    medianOfRuns: percentile(medians, 50),
    min: Math.min(...medians),
    max: Math.max(...medians),
    stdev: stdev(medians),
    cv: m === 0 ? 0 : (stdev(medians) / m) * 100,
  };
}

// ---- machine and pins -------------------------------------------------------------------------------------------

export async function pins(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const status = await capture(["git", "submodule", "status"]);
  for (const line of status.trim().split("\n")) {
    const [sha, name] = line.trim().replace(/^[-+U]/, "").split(/\s+/);
    if (sha && name) out[name.replace("vendor/", "")] = sha;
  }
  return out;
}

async function tryCapture(command: string[]): Promise<string> {
  try {
    return (await capture(command)).trim();
  } catch {
    return "n/a";
  }
}

export async function machine(): Promise<Record<string, string>> {
  const gpu = await tryCapture(["nvidia-smi", "--query-gpu=name,driver_version,memory.total,clocks.max.graphics,power.limit", "--format=csv,noheader"]);
  const os = await tryCapture(["cmd", "/c", "ver"]);
  const cpu = await tryCapture(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"]);
  return {
    gpu,
    cpu,
    os: os.replace(/\s+/g, " "),
    bun: Bun.version,
    deno: (await tryCapture(["deno", "--version"])).split("\n")[0] ?? "n/a",
    chrome: await chromeVersion(),
    date: new Date().toISOString(),
  };
}

export const CHROME = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
export const FIREFOX = process.env.FIREFOX ?? join(ROOT, ".tools", "firefox", "core", "firefox.exe");

export async function chromeVersion(): Promise<string> {
  if (!existsSync(CHROME)) return "n/a";
  return tryCapture(["powershell", "-NoProfile", "-Command", `(Get-Item '${CHROME}').VersionInfo.ProductVersion`]);
}

export async function writeJson(file: string, value: unknown) {
  ensureDir(dirname(file));
  await Bun.write(file, `${JSON.stringify(value, null, 1)}\n`);
}

/** Peak GPU memory used (MiB) above the idle baseline while `work` runs, sampled with nvidia-smi. */
export async function withGpuMemory<T>(work: () => Promise<T>): Promise<{ value: T; peakDeltaMiB: number }> {
  const read = async () => Number((await tryCapture(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"])).split("\n")[0]);
  const baseline = await read();
  let peak = baseline;
  let running = true;
  const sampler = (async () => {
    while (running) {
      const used = await read();
      if (Number.isFinite(used)) peak = Math.max(peak, used);
      await Bun.sleep(150);
    }
  })();
  try {
    return { value: await work(), peakDeltaMiB: peak - baseline };
  } finally {
    running = false;
    await sampler;
  }
}
