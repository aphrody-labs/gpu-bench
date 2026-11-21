// Local servers and process drivers: the result server, Chrome and Firefox launchers, native runners.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME, FIREFOX, ROOT, ensureDir, log, path } from "./common.ts";

const HELMET_DIR = path("vendor", "three.js", "examples", "models", "gltf", "DamagedHelmet", "glTF");
const ISOLATION = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };

const BEVY_PAGE = `<!doctype html><meta charset="utf-8"><title>gpu-bench bevy</title>
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style>
<canvas id="bevy"></canvas>
<script type="module">
window.__report = (text) => fetch("/result", { method: "POST", body: text });
import init from "/bevy-dist/gpu_bench_bevy.js";
init().catch((error) => { if (!String(error).includes("Using exceptions for control flow")) fetch("/result", { method: "POST", body: JSON.stringify({ failed: String(error?.stack ?? error) }) }); });
</script>`;

export interface ResultServer {
  url: string;
  next(timeoutMs: number): Promise<string>;
  stop(): void;
}

export function startServer(): ResultServer {
  let waiting: ((text: string) => void) | undefined;
  const queue: string[] = [];
  const serve = (file: string) => {
    const f = Bun.file(file);
    return new Response(f, { headers: ISOLATION });
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/result") {
        const text = await request.text();
        if (waiting) {
          waiting(text);
          waiting = undefined;
        } else queue.push(text);
        return new Response("ok", { headers: ISOLATION });
      }
      const rest = (prefix: string) => decodeURIComponent(url.pathname.slice(prefix.length)).replaceAll("..", "");
      if (url.pathname === "/browser") return serve(path("js", "browser.html"));
      if (url.pathname === "/three") return serve(path("scenes", "three", "index.html"));
      if (url.pathname === "/bevy") return new Response(BEVY_PAGE, { headers: { ...ISOLATION, "Content-Type": "text/html" } });
      if (url.pathname.startsWith("/dist/")) return serve(path("dist", rest("/dist/")));
      if (url.pathname.startsWith("/wgsl/")) return serve(path("wgsl", rest("/wgsl/")));
      if (url.pathname.startsWith("/assets/")) return serve(join(HELMET_DIR, rest("/assets/")));
      if (url.pathname.startsWith("/bevy-dist/")) return serve(path(".bin", "bevy-web", rest("/bevy-dist/")));
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    next: (timeoutMs) =>
      new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) return resolve(queued);
        const timer = setTimeout(() => {
          waiting = undefined;
          reject(new Error(`no result within ${timeoutMs} ms`));
        }, timeoutMs);
        waiting = (text) => {
          clearTimeout(timer);
          resolve(text);
        };
      }),
    stop: () => server.stop(true),
  };
}

async function killTree(pid: number) {
  await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited;
}

export type BrowserKind = "chrome" | "firefox";

/** Opens `url` in a fresh-profile browser, waits for one POSTed result, then closes the browser. */
export async function inBrowser(kind: BrowserKind, server: ResultServer, url: string, timeoutMs: number): Promise<{ text: string; spawnedAt: number }> {
  const profile = mkdtempSync(join(tmpdir(), `gpu-bench-${kind}-`));
  let command: string[];
  if (kind === "chrome") {
    command = [
      CHROME,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-webgpu",
      "--enable-webgpu-developer-features",
      "--disable-frame-rate-limit",
      "--disable-gpu-vsync",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--kiosk",
      url,
    ];
  } else {
    if (!existsSync(FIREFOX)) throw new Error(`firefox not found at ${FIREFOX}`);
    writeFileSync(
      join(profile, "user.js"),
      [
        'user_pref("dom.webgpu.enabled", true);',
        'user_pref("gfx.webgpu.ignore-blocklist", true);',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
        'user_pref("browser.tabs.warnOnClose", false);',
        'user_pref("privacy.reduceTimerPrecision", true);',
      ].join("\n"),
    );
    command = [FIREFOX, "-no-remote", "-profile", profile, "-kiosk", url];
  }
  const spawnedAt = performance.now();
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  try {
    return { text: await server.next(timeoutMs), spawnedAt };
  } finally {
    await killTree(child.pid);
    await Bun.sleep(1500);
  }
}

export interface NativeOutput {
  stdout: string;
  /** Wall-clock offsets (ms since spawn) at which marker lines appeared on stdout. */
  markers: Record<string, number>;
}

/** Runs a native command, collects stdout and timestamps lines that equal a marker name. */
export async function runNative(command: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs: number }): Promise<NativeOutput> {
  const spawnedAt = performance.now();
  const child = Bun.spawn(command, { cwd: options.cwd ?? ROOT, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => {
    log(`timeout: ${command.join(" ")}`);
    void killTree(child.pid);
  }, options.timeoutMs);
  const markers: Record<string, number> = {};
  let stdout = "";
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    stdout += chunk;
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (/^[A-Z_]+$/.test(line.trim())) markers[line.trim()] = performance.now() - spawnedAt;
  }
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}\n${stderr.slice(-1500)}`);
  return { stdout, markers };
}

export function lastJson(text: string): unknown {
  const line = text.trim().split("\n").reverse().find((entry) => entry.startsWith("{") || entry.startsWith("RESULT {"));
  if (!line) throw new Error(`no JSON in output: ${text.slice(-500)}`);
  return JSON.parse(line.replace(/^RESULT /, ""));
}

export { ensureDir };
