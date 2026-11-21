#!/usr/bin/env bun
// Skia (Chromium 160 pin) vs tiny-skia (Obscura) CPU rasterizer benchmark.
// usage: bun raster/run.ts <prep|build|bench|diffs|pages|report|all> [--runs N] [--warmup N] [--only substring] [--rebuild] [--skia-jobs N]
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { join, relative, resolve } from "node:path";
import * as S from "./scenes.ts";
import { crop, decodePng, diffImage, encodePng, fidelity, run, sideBySide, stats, viewable, type Fidelity, type Image } from "./util.ts";

const ROOT = import.meta.dir;
const REPO = resolve(ROOT, "..");
const SKIA = join(REPO, "vendor", "skia");
const OBSCURA = join(REPO, "vendor", "obscura");
const WORK = process.env.RASTER_WORK ?? join(ROOT, "work");
const SCENES = join(WORK, "scenes");
const ASSETS = join(WORK, "assets");
const BIN = join(WORK, "bin");
const RESULTS = join(ROOT, "results");
const EXE = platform() === "win32" ? ".exe" : "";
const HOST = `${platform() === "win32" ? "windows" : platform()}-${hostname().toLowerCase()}`;

const args = process.argv.slice(2);
const command = args[0] ?? "all";
const flag = (name: string) => args.indexOf(name) >= 0;
const option = (name: string, fallback: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1]! : fallback);
const RUNS = Number(option("--runs", "20"));
const WARMUP = Number(option("--warmup", "3"));
const ONLY = option("--only", "");
const log = (message: string) => console.error(`[raster] ${message}`);

export interface Variant {
  readonly id: string;
  readonly label: string;
  readonly profile: "release" | "release-dist";
  readonly rustflags: string;
}
export const VARIANTS: readonly Variant[] = [
  { id: "tiny-dist", label: "tiny-skia, release-dist (Obscura as shipped: opt-level s, fat LTO)", profile: "release-dist", rustflags: "" },
  { id: "tiny-opt3", label: "tiny-skia, release (opt-level 3, baseline x86-64)", profile: "release", rustflags: "" },
  { id: "tiny-v3", label: "tiny-skia, release + target-cpu=x86-64-v3 (AVX2)", profile: "release", rustflags: "-C target-cpu=x86-64-v3" },
];
const PRIMARY = "tiny-dist";

interface SceneEntry { name: string; group: string; dprs: readonly number[]; file: string; width: number; height: number }

// ---------------------------------------------------------------- prep

function photo(size: number, seed: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  let state = seed >>> 0;
  const noise = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const ring = Math.sin(Math.hypot(u - 0.4, v - 0.55) * 60) * 0.5 + 0.5;
      const wave = Math.sin(u * 23 + Math.sin(v * 17) * 3) * 0.5 + 0.5;
      const detail = Math.sin(u * size * 0.35) * Math.sin(v * size * 0.35) * 0.5 + 0.5;
      const index = (y * size + x) * 4;
      data[index] = 255 * (0.15 + 0.6 * ring * (1 - v) + 0.2 * detail);
      data[index + 1] = 255 * (0.2 + 0.5 * wave * u + 0.2 * noise() * 0.5 + 0.1 * detail);
      data[index + 2] = 255 * (0.25 + 0.5 * (1 - ring) * v + 0.1 * wave);
      data[index + 3] = 255;
    }
  }
  return data;
}

async function loadSprite(): Promise<Parameters<typeof S.sprite>[0]> {
  const dir = join(ROOT, "assets", "byron-love");
  const plan = (await Bun.file(join(dir, "byron-love.json")).json()) as {
    sources: Record<string, string>; margin?: number;
    states: Record<string, { source: string; dx?: number; dy?: number; mirror?: boolean }[]>;
  };
  // Layout of @open-pets/pet-format defaultPetSprite (1536x2288 sheet of 192x208 cells, 8 columns, 11 rows).
  const rows: Record<string, number> = { idle: 0, "running-right": 1, "running-left": 2, waving: 3, jumping: 4, failed: 5, waiting: 6, running: 7, review: 8 };
  const cell = { w: 192, h: 208 }, sheet = { w: 1536, h: 2288 }, neutralColumn = 6;
  const decoded = new Map<string, Image>();
  for (const name of Object.keys(plan.sources)) {
    const bytes = new Uint8Array(await Bun.file(join(dir, `${name}.webp`)).arrayBuffer());
    const png = await new Bun.Image(bytes).png().toBuffer();
    decoded.set(name, decodePng(new Uint8Array(png)));
  }
  const box = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
  for (const image of decoded.values()) {
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (image.data[(y * image.width + x) * 4 + 3]! > 8) {
          box.left = Math.min(box.left, x); box.right = Math.max(box.right, x);
          box.top = Math.min(box.top, y); box.bottom = Math.max(box.bottom, y);
        }
      }
    }
  }
  const cropW = box.right - box.left + 1, cropH = box.bottom - box.top + 1;
  const margin = plan.margin ?? 6;
  const headroom = 2 + Math.max(0, ...Object.values(plan.states).flat().map((frame) => -(frame.dy ?? 0)));
  const scale = Math.min((cell.w - 2 * margin) / cropW, (cell.h - margin - headroom) / cropH);
  const scaled = { w: Math.max(1, Math.round(cropW * scale)), h: Math.max(1, Math.round(cropH * scale)) };
  const pad = { x: Math.floor((cell.w - scaled.w) / 2), y: cell.h - margin - scaled.h };
  const sources = new Map<string, { file: string }>();
  for (const [name, image] of decoded) {
    const out = new Uint8Array(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const from = ((box.top + y) * image.width + box.left + x) * 4, to = (y * cropW + x) * 4;
        const alpha = image.data[from + 3]!;
        for (let c = 0; c < 3; c++) out[to + c] = Math.round((image.data[from + c]! * alpha) / 255);
        out[to + 3] = alpha;
      }
    }
    const file = `sprite-${name}.rgba`;
    await writeFile(join(ASSETS, file), out);
    sources.set(name, { file: `../assets/${file}` });
  }
  const frames: { source: string; row: number; column: number; dx: number; dy: number; mirror: boolean }[] = [];
  for (const [state, list] of Object.entries(plan.states)) {
    list.forEach((frame, column) => frames.push({ source: frame.source, row: rows[state]!, column, dx: frame.dx ?? 0, dy: frame.dy ?? 0, mirror: frame.mirror ?? false }));
  }
  frames.push({ source: plan.states.idle![0]!.source, row: 0, column: neutralColumn, dx: 0, dy: 0, mirror: false });
  for (const spare of [9, 10]) plan.states.idle!.forEach((frame, column) => frames.push({ source: frame.source, row: spare, column, dx: 0, dy: frame.dy ?? 0, mirror: false }));
  return { cell, sheet, crop: { w: cropW, h: cropH }, scaled, pad, frames, sources };
}

async function prep(): Promise<SceneEntry[]> {
  await mkdir(SCENES, { recursive: true });
  await mkdir(ASSETS, { recursive: true });
  const fontPath = join(OBSCURA, "vendor", "cosmic-text", "fonts", "NotoSans-Regular.ttf");
  if (!existsSync(fontPath)) throw new Error(`missing ${fontPath}: run git submodule update --init --depth 1 vendor/obscura`);
  const images = new Map<string, { width: number; height: number; file: string }>();
  for (const [name, size, seed] of [["photo256", 256, 7], ["photo2048", 2048, 9]] as const) {
    await writeFile(join(ASSETS, `${name}.rgba`), photo(size, seed));
    images.set(name, { width: size, height: size, file: `../assets/${name}.rgba` });
  }
  const assets: S.Assets = { dir: SCENES, fontPath, images };
  const tokens = Bun.TOML.parse(await readFile(join(ROOT, "assets", "google_design_tokens.toml"), "utf8")) as { sys: { color: { dark: Record<string, string> }; shape: Record<string, number> } };
  const sprite = await loadSprite();
  const scenes: S.SceneFile[] = [
    S.pathFill(), S.pathStroke(), S.hairlines(), S.dashes(), ...S.gradients(), ...S.images(assets), ...S.blends(), ...S.clips(), ...S.texts(assets),
    S.m3Screen({ dark: tokens.sys.color.dark, shape: tokens.sys.shape }, assets),
    S.sprite(sprite, "bilinear"), S.sprite(sprite, "bicubic"), S.sprite(sprite, "mip"), S.blurProbe(),
  ];
  const entries: SceneEntry[] = [];
  for (const scene of scenes) {
    const file = await S.writeScene(SCENES, scene);
    entries.push({ name: scene.name, group: scene.group, dprs: scene.dprs, file, width: scene.width, height: scene.height });
  }
  await writeFile(join(SCENES, "manifest.json"), JSON.stringify(entries, null, 1));
  log(`prep: ${entries.length} scenes in ${SCENES}`);
  return entries;
}

async function manifest(): Promise<SceneEntry[]> {
  const file = join(SCENES, "manifest.json");
  return existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as SceneEntry[]) : prep();
}

// ---------------------------------------------------------------- build

interface BuildInfo {
  host: string;
  loadavg: number[];
  skia?: { seconds: number; libs: Record<string, number>; harness_seconds: number; harness_bytes: number; harness_stripped_bytes: number; ninja_steps: number };
  tiny: Record<string, { seconds: number; bin_bytes: number; bin_stripped_bytes: number; rlibs?: Record<string, number> }>;
  tiny_notext?: { seconds: number; bin_stripped_bytes: number };
  obscura?: Record<string, { seconds: number; bin_stripped_bytes: number }>;
}

const buildFile = () => join(WORK, "build.json");
async function loadBuild(): Promise<BuildInfo> {
  return existsSync(buildFile()) ? JSON.parse(await readFile(buildFile(), "utf8")) : { host: HOST, loadavg: [], tiny: {} };
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

async function stripped(path: string): Promise<number> {
  if (platform() === "win32") return fileSize(path);
  const out = `${path}.stripped`;
  const result = await run(["strip", "-o", out, path], { quiet: true });
  if (result.code !== 0) return fileSize(path);
  const size = await fileSize(out);
  await rm(out);
  return size;
}

async function buildSkia(info: BuildInfo) {
  const outDir = join(SKIA, "out", "Release");
  const jobs = option("--skia-jobs", "");
  if (!existsSync(join(SKIA, "bin", "gn")) && !existsSync(join(SKIA, "bin", "gn.exe"))) {
    log("skia: git-sync-deps + fetch-gn");
    await run(["python3", "tools/git-sync-deps"], { cwd: SKIA });
    await run(["python3", "bin/fetch-gn"], { cwd: SKIA });
    // CPU raster needs none of these checkouts; they take ~6 GB.
    for (const dep of ["unicodetools", "swiftshader", "emsdk", "dawn", "angle2", "perfetto", "opengl-registry", "icu4x", "glslang", "vulkan-headers", "egl-registry", "imgui", "oboe"]) {
      await rm(join(SKIA, "third_party", "externals", dep), { recursive: true, force: true });
    }
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "args.gn"), await readFile(join(ROOT, "skia", "gn-args.txt"), "utf8"));
  await run([join(SKIA, "bin", "gn"), "gen", outDir], { cwd: SKIA });
  const targets = ["skia", "modules/skshaper:skshaper", "modules/skunicode:skunicode"];
  const ninja = await run(["ninja", "-C", outDir, ...(jobs ? ["-j", jobs] : []), ...targets], { cwd: SKIA });
  if (ninja.code !== 0) throw new Error("skia ninja failed");
  const steps = Number(/\[(\d+)\/(\d+)\]/.exec(ninja.stdout.split("\n").filter((l) => l.startsWith("[")).at(-1) ?? "")?.[2] ?? 0);
  const prior = info.skia;
  // A rebuild that finds everything up to date takes ~0s: keep the cold-build time measured earlier.
  const seconds = ninja.seconds > 30 || !prior ? ninja.seconds : prior.seconds;
  const libs: Record<string, number> = {};
  for (const file of (await readdir(outDir)).filter((f) => f.endsWith(".a"))) libs[file] = await fileSize(join(outDir, file));

  // Compile the harness with Skia's own defines and include paths.
  const desc = JSON.parse((await run([join(SKIA, "bin", "gn"), "desc", outDir, "//:skia", "--format=json"], { cwd: SKIA })).stdout.slice((await run([join(SKIA, "bin", "gn"), "desc", outDir, "//:skia", "--format=json"], { cwd: SKIA })).stdout.indexOf("{")))["//:skia"] as { defines?: string[]; include_dirs?: string[]; cflags_cc?: string[]; cflags?: string[] };
  const harnessStart = performance.now();
  await mkdir(BIN, { recursive: true });
  const archives = Object.keys(libs).map((lib) => join(outDir, lib));
  const compile = await run([
    "clang++", "-std=c++17", "-O2", "-fno-rtti", ...(desc.cflags_cc ?? []).filter((f) => f.startsWith("-std") === false && f !== "-fno-rtti"), ...(desc.defines ?? []).map((d) => `-D${d}`),
    `-I${SKIA}`,
    join(ROOT, "skia", "bench.cpp"), "-o", join(BIN, `bench-skia${EXE}`), "-Wl,--start-group", ...archives, "-Wl,--end-group", "-lpthread", "-ldl",
  ], { cwd: SKIA });
  if (compile.code !== 0) throw new Error("skia harness compile failed");
  const bin = join(BIN, `bench-skia${EXE}`);
  info.skia = { seconds, libs, harness_seconds: (performance.now() - harnessStart) / 1000, harness_bytes: await fileSize(bin), harness_stripped_bytes: await stripped(bin), ninja_steps: steps || prior?.ninja_steps || 0 };
  log(`skia: ${seconds.toFixed(0)}s lib build, harness ${info.skia.harness_bytes} B`);
}

async function buildRust(info: BuildInfo) {
  const manifestPath = join(ROOT, "rust", "Cargo.toml");
  const base = (variant: Variant) => ({ CARGO_TARGET_DIR: join(WORK, "cargo", variant.id), RUSTFLAGS: variant.rustflags });
  await mkdir(BIN, { recursive: true });
  for (const variant of VARIANTS) {
    const started = performance.now();
    const built = await run(["cargo", "build", "--profile", variant.profile, "--manifest-path", manifestPath, "--bin", "bench-tiny", "--locked"], { env: base(variant) });
    if (built.code !== 0) throw new Error(`cargo build ${variant.id} failed`);
    const out = join(WORK, "cargo", variant.id, variant.profile, `bench-tiny${EXE}`);
    const target = join(BIN, `bench-${variant.id}${EXE}`);
    await Bun.write(target, Bun.file(out));
    if (EXE === "") await run(["chmod", "+x", target]);
    const rlibs: Record<string, number> = {};
    const deps = join(WORK, "cargo", variant.id, variant.profile, "deps");
    for (const file of await readdir(deps)) {
      if (/^libtiny_skia.*\.rlib$/.test(file) || /^libcosmic_text.*\.rlib$/.test(file) || /^libswash.*\.rlib$/.test(file)) rlibs[file.replace(/-[0-9a-f]+\.rlib$/, "")] = await fileSize(join(deps, file));
    }
    info.tiny[variant.id] = { seconds: (performance.now() - started) / 1000, bin_bytes: await fileSize(target), bin_stripped_bytes: await stripped(target), rlibs };
    log(`tiny ${variant.id}: ${info.tiny[variant.id]!.seconds.toFixed(0)}s, ${info.tiny[variant.id]!.bin_stripped_bytes} B stripped`);
  }
  // tiny-skia alone (no cosmic-text/swash) for the size of the rasterizer without a text stack.
  const started = performance.now();
  const notext = { CARGO_TARGET_DIR: join(WORK, "cargo", "tiny-notext"), RUSTFLAGS: "" };
  const result = await run(["cargo", "build", "--profile", "release-dist", "--manifest-path", manifestPath, "--bin", "bench-tiny", "--no-default-features", "--locked"], { env: notext });
  if (result.code === 0) {
    const out = join(WORK, "cargo", "tiny-notext", "release-dist", `bench-tiny${EXE}`);
    info.tiny_notext = { seconds: (performance.now() - started) / 1000, bin_stripped_bytes: await stripped(out) };
  }
  // Obscura page-render harness, shipped profile and plain release.
  info.obscura = {};
  for (const variant of VARIANTS.slice(0, 2)) {
    const pageStart = performance.now();
    const built = await run(["cargo", "build", "--profile", variant.profile, "--manifest-path", manifestPath, "--features", "page", "--bin", "page-obscura", "--locked"], { env: { CARGO_TARGET_DIR: join(WORK, "cargo", `page-${variant.id}`), RUSTFLAGS: "" } });
    if (built.code !== 0) throw new Error(`cargo build page ${variant.id} failed`);
    const out = join(WORK, "cargo", `page-${variant.id}`, variant.profile, `page-obscura${EXE}`);
    const target = join(BIN, `page-${variant.id}${EXE}`);
    await Bun.write(target, Bun.file(out));
    if (EXE === "") await run(["chmod", "+x", target]);
    info.obscura[variant.id] = { seconds: (performance.now() - pageStart) / 1000, bin_stripped_bytes: await stripped(target) };
  }
}

async function build() {
  await mkdir(WORK, { recursive: true });
  const info = await loadBuild();
  info.host = HOST;
  info.loadavg = (await import("node:os")).loadavg();
  if (flag("--rebuild") || !existsSync(join(BIN, `bench-skia${EXE}`))) await buildSkia(info);
  if (flag("--rebuild") || !existsSync(join(BIN, `bench-${PRIMARY}${EXE}`)) || !info.obscura) await buildRust(info);
  await writeFile(buildFile(), JSON.stringify(info, null, 1));
}

// ---------------------------------------------------------------- bench

interface RunOutput {
  engine: string;
  unsupported?: string;
  width?: number;
  height?: number;
  dpr?: number;
  first_ms?: number;
  rss_kb?: number;
  rss_baseline_kb?: number;
  times_ms?: number[];
  cpu_times_ms?: number[];
}

async function execute(engine: string, scene: SceneEntry, dpr: number, frame?: string): Promise<RunOutput> {
  const binary = join(BIN, engine === "skia" ? `bench-skia${EXE}` : `bench-${engine}${EXE}`);
  const result = await run([binary, "--scene", scene.file, "--dpr", String(dpr), "--runs", String(RUNS), "--warmup", String(WARMUP), ...(frame ? ["--out", frame] : [])], { quiet: true });
  if (result.code !== 0) return { engine, unsupported: `exit ${result.code}: ${result.stderr.trim().split("\n").at(-1)}` };
  return JSON.parse(result.stdout) as RunOutput;
}

interface Row {
  scene: string;
  group: string;
  dpr: number;
  engine: string;
  unsupported?: string;
  first_ms?: number;
  rss_kb?: number;
  rss_baseline_kb?: number;
  wall?: ReturnType<typeof stats>;
  cpu?: ReturnType<typeof stats>;
}
interface FidelityRow extends Fidelity { scene: string; dpr: number; engine: string }

async function bench() {
  const scenes = (await manifest()).filter((scene) => scene.name.includes(ONLY));
  const rows: Row[] = [];
  const fidelityRows: FidelityRow[] = [];
  const tmp = join(WORK, "tmp");
  await mkdir(tmp, { recursive: true });
  const engines = ["skia", ...VARIANTS.map((v) => v.id)];
  for (const scene of scenes) {
    for (const dpr of scene.dprs) {
      const frames = new Map<string, string>();
      for (const engine of engines) {
        const dump = engine === "skia" || engine === PRIMARY ? join(tmp, `${engine}.rgba`) : undefined;
        const output = await execute(engine, scene, dpr, dump);
        if (dump) frames.set(engine, dump);
        const row: Row = { scene: scene.name, group: scene.group, dpr, engine };
        if (output.unsupported) row.unsupported = output.unsupported;
        else {
          row.first_ms = output.first_ms;
          row.rss_kb = output.rss_kb;
          row.rss_baseline_kb = output.rss_baseline_kb;
          row.wall = stats(output.times_ms!);
          const hasCpu = output.cpu_times_ms!.some((v) => v > 0);
          row.cpu = stats(hasCpu ? output.cpu_times_ms! : output.times_ms!);
        }
        rows.push(row);
      }
      const skia = rows.find((r) => r.scene === scene.name && r.dpr === dpr && r.engine === "skia");
      const tiny = rows.find((r) => r.scene === scene.name && r.dpr === dpr && r.engine === PRIMARY);
      if (skia?.cpu && tiny?.cpu) {
        const a = new Uint8Array(await readFile(frames.get("skia")!)), b = new Uint8Array(await readFile(frames.get(PRIMARY)!));
        const width = Math.round(scene.width * dpr);
        fidelityRows.push({ scene: scene.name, dpr, engine: PRIMARY, ...fidelity(a, b, width) });
      }
      for (const file of frames.values()) await rm(file, { force: true });
      const line = rows.filter((r) => r.scene === scene.name && r.dpr === dpr).map((r) => `${r.engine}=${r.cpu ? r.cpu.p50.toFixed(2) : "n/a"}`).join(" ");
      log(`${scene.name}@${dpr}x ${line}`);
    }
  }
  await mkdir(RESULTS, { recursive: true });
  const build = await loadBuild();
  const meta = {
    host: HOST, runs: RUNS, warmup: WARMUP, platform: platform(), arch: arch(), os: release(), cpu: cpus()[0]?.model ?? "", threads: cpus().length,
    memory_gb: Math.round(totalmem() / 2 ** 30), loadavg_start: (await import("node:os")).loadavg(), date: new Date().toISOString(),
    skia_revision: (await run(["git", "-C", SKIA, "rev-parse", "HEAD"])).stdout.trim(), obscura_revision: (await run(["git", "-C", OBSCURA, "rev-parse", "HEAD"])).stdout.trim(),
  };
  const out = join(RESULTS, `${HOST}.json`);
  const previous = existsSync(out) && ONLY ? JSON.parse(await readFile(out, "utf8")) : undefined;
  const mergedRows = previous ? [...previous.rows.filter((r: Row) => !r.scene.includes(ONLY)), ...rows] : rows;
  const mergedFidelity = previous ? [...previous.fidelity.filter((r: FidelityRow) => !r.scene.includes(ONLY)), ...fidelityRows] : fidelityRows;
  const facts = await sourceFacts(mergedRows);
  await writeFile(out, JSON.stringify({ meta: { ...meta, loadavg_end: (await import("node:os")).loadavg() }, build, rows: mergedRows, fidelity: mergedFidelity, facts }, null, 1));
  log(`wrote ${relative(REPO, out)}`);
}


// ---------------------------------------------------------------- facts (feature gaps, measured from the sources)

async function countLines(files: string[]): Promise<number> {
  let total = 0;
  for (const file of files) total += (await readFile(file, "utf8")).split("\n").length;
  return total;
}

async function sourceFacts(rows: Row[]): Promise<Record<string, { skia: string; tiny: string }>> {
  const home = process.env.CARGO_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".cargo");
  const registry = join(home, "registry", "src");
  let tinyDir = "";
  for (const index of existsSync(registry) ? await readdir(registry) : []) {
    const candidate = join(registry, index, "tiny-skia-0.12.0", "src");
    if (existsSync(candidate)) tinyDir = candidate;
  }
  const glob = async (root: string, pattern: string) => Array.from(new Bun.Glob(pattern).scanSync({ cwd: root, absolute: true }));
  const facts: Record<string, { skia: string; tiny: string }> = {};
  const blendHeader = await readFile(join(SKIA, "include", "core", "SkBlendMode.h"), "utf8");
  const skiaBlend = /enum class SkBlendMode[^{]*\{([\s\S]*?)\};/.exec(blendHeader)?.[1]?.match(/^\s*k[A-Z]\w*(?=,)/gm)?.filter((name) => !/kLastCoeffMode|kLastSeparableMode|kLastMode/.test(name)).length ?? 0;
  if (tinyDir) {
    const tinyBlend = /pub enum BlendMode \{([\s\S]*?)\n\}/.exec(await readFile(join(tinyDir, "blend_mode.rs"), "utf8"))?.[1]?.match(/^\s{4}[A-Z]\w*,/gm)?.length ?? 0;
    facts["blend modes"] = { skia: String(skiaBlend), tiny: String(tinyBlend) };
    const shaders = (await glob(join(tinyDir, "shaders"), "*.rs")).map((p) => p.replace(/^.*[\\/]/, ""));
    facts["gradient/shader types"] = { skia: "linear, radial, two-point conical, sweep, image, perlin noise, runtime (SkSL)", tiny: `${shaders.filter((n) => /gradient|pattern/.test(n) && !/^gradient\.rs$/.test(n)).map((n) => n.replace(".rs", "")).join(", ")}` };
    const tinyFiles = await glob(tinyDir, "**/*.rs");
    facts["source size (lines, src/)"] = { skia: "n/a", tiny: `${await countLines(tinyFiles)} lines in ${tinyFiles.length} .rs files (tiny-skia 0.12.0)` };
    const tinyText = (await Promise.all(tinyFiles.map((p) => readFile(p, "utf8")))).join("\n");
    facts["text / glyph API"] = { skia: "SkFont, SkTextBlob, SkShaper (HarfBuzz), SkParagraph", tiny: `none (${(tinyText.match(/glyph|font/gi) ?? []).length} mentions of glyph/font in its source); Obscura adds cosmic-text + swash` };
    facts["blur / shadow / image filters"] = { skia: "SkMaskFilter blur, SkImageFilters (blur, morphology, lighting, ...)", tiny: `none (${(tinyText.match(/blur|ImageFilter|DropShadow/gi) ?? []).length} mentions in its source)` };
    facts["mipmaps (FilterQuality::Medium)"] = { skia: "linear/nearest mip modes in SkSamplingOptions", tiny: "not implemented (documented in pattern.rs: 'we do not support FilterQuality::Medium')" };
  }
  const skiaFiles = (await run(["git", "-C", SKIA, "ls-files", "src", "include"], { quiet: true })).stdout.split("\n").filter((p) => /\.(cpp|h|inc)$/.test(p));
  const gpuFiles = skiaFiles.filter((p) => p.startsWith("src/gpu/"));
  const coreLines = await countLines(skiaFiles.filter((p) => !p.startsWith("src/gpu/")).map((p) => join(SKIA, p)));
  facts["source size (lines, src/ + include/)"] = { skia: `${coreLines} lines outside src/gpu in ${skiaFiles.length - gpuFiles.length} files`, tiny: facts["source size (lines, src/)"]?.tiny ?? "n/a" };
  facts["GPU backends"] = { skia: `Ganesh and Graphite: ${gpuFiles.length} files under src/gpu (disabled in this CPU-only build: skia_enable_ganesh=false, skia_enable_graphite=false)`, tiny: "none (CPU only)" };
  const skiaRow = (scene: string) => rows.find((r) => r.scene === scene && r.dpr === 1 && r.engine === "skia")?.cpu?.p50;
  const tinyRow = (scene: string) => rows.find((r) => r.scene === scene && r.dpr === 1 && r.engine === PRIMARY);
  for (const [name, scene] of [["mipmapped downscale (image-mip scene)", "image-mip"], ["blurred box-shadow (gap-blur-shadow scene)", "gap-blur-shadow"], ["mipmapped sprite sheet (sprite-sheet-mip)", "sprite-sheet-mip"]] as const) {
    facts[name] = { skia: `${skiaRow(scene)?.toFixed(2) ?? "n/a"} ms p50`, tiny: tinyRow(scene)?.unsupported ? `unsupported (${tinyRow(scene)!.unsupported})` : "rendered" };
  }
  for (const [name, dir] of [["boolean path ops", "modules/pathops"], ["runtime shaders / SkSL", "src/sksl"], ["PDF / SVG / Skottie modules", "modules/skottie"]] as const) {
    facts[name] = { skia: existsSync(join(SKIA, dir)) ? `${(await run(["git", "-C", SKIA, "ls-files", dir], { quiet: true })).stdout.split("\n").filter(Boolean).length} files in ${dir}` : "absent", tiny: "none" };
  }
  return facts;
}

// ---------------------------------------------------------------- diffs

async function diffs() {
  const file = join(RESULTS, `${HOST}.json`);
  const data = JSON.parse(await readFile(file, "utf8")) as { fidelity: FidelityRow[] };
  const manifestList = await manifest();
  const dir = join(RESULTS, "diff");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const worst = [...data.fidelity].filter((r) => r.dpr === 1 && Number.isFinite(r.psnr)).sort((a, b) => a.psnr - b.psnr).slice(0, 8);
  const extra = data.fidelity.filter((r) => r.dpr === 2 && Number.isFinite(r.psnr)).sort((a, b) => a.psnr - b.psnr).slice(0, 2);
  const tmp = join(WORK, "tmp");
  await mkdir(tmp, { recursive: true });
  for (const row of [...worst, ...extra]) {
    const scene = manifestList.find((s) => s.name === row.scene)!;
    const skiaPath = join(tmp, "d-skia.rgba"), tinyPath = join(tmp, "d-tiny.rgba");
    const savedRuns = RUNS;
    void savedRuns;
    await run([join(BIN, `bench-skia${EXE}`), "--scene", scene.file, "--dpr", String(row.dpr), "--runs", "1", "--warmup", "0", "--out", skiaPath], { quiet: true });
    await run([join(BIN, `bench-${PRIMARY}${EXE}`), "--scene", scene.file, "--dpr", String(row.dpr), "--runs", "1", "--warmup", "0", "--out", tinyPath], { quiet: true });
    const width = Math.round(scene.width * row.dpr), height = Math.round(scene.height * row.dpr);
    const a = new Uint8Array(await readFile(skiaPath)), b = new Uint8Array(await readFile(tinyPath));
    const skiaView = viewable(a, width, height), tinyView = viewable(b, width, height), delta = diffImage(a, b, width, height);
    const tag = `${row.scene}@${row.dpr}x`;
    const size = 128, zoom = row.dpr === 1 ? 3 : 2;
    await writeFile(join(dir, `${tag}-diff.png`), encodePng(delta));
    await writeFile(join(dir, `${tag}-crop.png`), encodePng(sideBySide([crop(skiaView, row.worst.x, row.worst.y, size, zoom), crop(tinyView, row.worst.x, row.worst.y, size, zoom), crop(delta, row.worst.x, row.worst.y, size, zoom)])));
    if (row.dpr === 1) {
      await writeFile(join(dir, `${tag}-skia.png`), encodePng(skiaView));
      await writeFile(join(dir, `${tag}-tiny.png`), encodePng(tinyView));
    }
    await rm(skiaPath, { force: true });
    await rm(tinyPath, { force: true });
    log(`diff ${tag}: psnr ${row.psnr.toFixed(2)} dB, max ${row.maxDelta}`);
  }
}

// ---------------------------------------------------------------- pages (Obscura only)

const PAGES: { name: string; file: string }[] = [
  { name: "site-index", file: resolve(REPO, "..", "aphrody", "site", "public", "index.html") },
  { name: "site-framework", file: resolve(REPO, "..", "aphrody", "site", "public", "framework.html") },
  { name: "site-studio", file: resolve(REPO, "..", "aphrody", "site", "public", "studio.html") },
  { name: "obscura-repro-bootstrap-float", file: join(OBSCURA, "render-repros", "bootstrap-float-clearfix.html") },
  { name: "obscura-repro-box-shadow", file: join(OBSCURA, "render-repros", "box-shadow-outset.html") },
];

async function pages() {
  const out = join(RESULTS, "pages");
  await mkdir(out, { recursive: true });
  const entries: unknown[] = [];
  const dir = join(WORK, "pages");
  await mkdir(dir, { recursive: true });
  for (const page of PAGES) {
    const source = process.env.RASTER_PAGES ? join(process.env.RASTER_PAGES, `${page.name}.html`) : page.file;
    const local = existsSync(source) ? source : join(ROOT, "assets", "pages", `${page.name}.html`);
    if (!existsSync(local)) { log(`pages: skip ${page.name} (not found)`); continue; }
    for (const variant of ["tiny-dist", "tiny-opt3"]) {
      const result = await run([join(BIN, `page-${variant}${EXE}`), "--html", local, "--viewport", "1920x1080", "--runs", String(RUNS), "--warmup", String(WARMUP), "--out", join(out, `${page.name}.png`)], { quiet: true });
      if (result.code !== 0) { log(`pages: ${page.name} ${variant} failed: ${result.stderr.slice(-300)}`); continue; }
      const json = JSON.parse(result.stdout) as Record<string, number[] | number | string>;
      const summarize = (key: string) => stats(json[key] as number[]);
      entries.push({ page: page.name, variant, html_bytes: json.html_bytes, png_bytes: json.png_bytes, rss_kb: json.rss_kb, rss_baseline_kb: json.rss_baseline_kb, first_ms: json.first_ms, parse: summarize("parse_ms"), prepare: summarize("prepare_ms"), paint: summarize("paint_ms"), encode: summarize("encode_ms") });
      log(`page ${page.name} ${variant}: paint p50 ${summarize("paint_ms").p50.toFixed(1)} ms`);
    }
  }
  const file = join(RESULTS, `${HOST}.json`);
  const data = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : { meta: { host: HOST }, rows: [], fidelity: [] };
  data.pages = entries;
  await writeFile(file, JSON.stringify(data, null, 1));
}

// ---------------------------------------------------------------- main

switch (command) {
  case "prep": await prep(); break;
  case "build": await build(); break;
  case "bench": await bench(); break;
  case "diffs": await diffs(); break;
  case "pages": await pages(); break;
  case "report": await (await import("./report.ts")).report(RESULTS, ROOT); break;
  case "all":
    await prep(); await build(); await bench(); await diffs(); await pages(); await (await import("./report.ts")).report(RESULTS, ROOT);
    break;
  default:
    console.error("usage: bun raster/run.ts <prep|build|bench|diffs|pages|report|all>");
    process.exit(2);
}
