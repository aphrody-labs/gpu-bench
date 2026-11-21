// Generates raster/RESULTS.md from results/<host>.json (tables only; prose that carries judgement lives in RESULTS.conclusion.md).
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

interface StatsLike { runs: number; min: number; p50: number; p95: number; mean: number; mad: number }
interface Row { scene: string; group: string; dpr: number; engine: string; unsupported?: string; first_ms?: number; rss_kb?: number; rss_baseline_kb?: number; wall?: StatsLike; cpu?: StatsLike }
interface FidelityRow { scene: string; dpr: number; psnr: number | null; maxDelta: number; meanAbs: number; over2: number; over16: number; worst: { x: number; y: number } }
interface PageRow { page: string; variant: string; html_bytes: number; png_bytes: number; rss_kb: number; rss_baseline_kb: number; first_ms: number[]; parse: StatsLike; prepare: StatsLike; paint: StatsLike; encode: StatsLike }
interface Results {
  meta: Record<string, any>;
  build: any;
  rows: Row[];
  fidelity: FidelityRow[];
  pages?: PageRow[];
  facts?: Record<string, any>;
}

const f = (value: number | undefined, digits = 2) => (value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(digits));
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MiB`;
const kb = (value: number | undefined) => (value === undefined ? "n/a" : `${(value / 1024).toFixed(0)} MiB`);

function geomean(values: number[]): number {
  return values.length === 0 ? NaN : Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length);
}

export async function report(resultsDir: string, root: string) {
  const files = (await readdir(resultsDir)).filter((file) => file.endsWith(".json"));
  const out: string[] = [];
  for (const file of files) {
    const data = JSON.parse(await readFile(join(resultsDir, file), "utf8")) as Results;
    out.push(...section(data, resultsDir, root));
  }
  const header = await readFile(join(root, "RESULTS.header.md"), "utf8").catch(() => "");
  const conclusion = await readFile(join(root, "RESULTS.conclusion.md"), "utf8").catch(() => "");
  await writeFile(join(root, "RESULTS.md"), [header, ...out, conclusion].join("\n"));
  console.error(`[raster] wrote ${join(root, "RESULTS.md")}`);
}

function section(data: Results, resultsDir: string, root: string): string[] {
  const m = data.meta;
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  const at = (scene: string, dpr: number, engine: string) => data.rows.find((r) => r.scene === scene && r.dpr === dpr && r.engine === engine);
  const scenes = [...new Set(data.rows.map((r) => r.scene))];
  const groups = [...new Set(data.rows.map((r) => r.group))];
  const variants = [...new Set(data.rows.map((r) => r.engine))].filter((e) => e !== "skia");

  push(`## Host ${m.host}`, "",
    `CPU ${m.cpu} (${m.threads} threads), ${m.memory_gb} GiB, ${m.os}, ${m.arch}. ${m.runs} timed runs after ${m.warmup} warm-ups per cell, single thread, CPU raster. ` +
    `Load average at start ${m.loadavg_start?.map((v: number) => v.toFixed(1)).join(" / ")}, at end ${m.loadavg_end?.map((v: number) => v.toFixed(1)).join(" / ")}. ` +
    `Skia ${String(m.skia_revision).slice(0, 10)}, Obscura ${String(m.obscura_revision).slice(0, 10)}. Times below are thread CPU milliseconds unless the host has no thread CPU clock (then wall).`, "");

  // Summary per group.
  push("### Summary: tiny-skia / Skia ratio of p50 frame time (below 1 = tiny-skia faster)", "", "| group | scenes | 1x tiny-dist | 1x tiny-opt3 | 1x tiny-v3 | 2x tiny-dist | 2x tiny-opt3 | 2x tiny-v3 |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const group of groups) {
    const names = scenes.filter((s) => data.rows.find((r) => r.scene === s)?.group === group);
    const cells = [1, 2].flatMap((dpr) => ["tiny-dist", "tiny-opt3", "tiny-v3"].map((variant) => {
      const ratios = names.map((s) => { const a = at(s, dpr, "skia")?.cpu?.p50, b = at(s, dpr, variant)?.cpu?.p50; return a && b ? b / a : NaN; }).filter(Number.isFinite);
      return ratios.length ? f(geomean(ratios), 2) : "n/a";
    }));
    push(`| ${group} | ${names.length} | ${cells.join(" | ")} |`);
  }
  push("", "Geometric mean of per-scene ratios; scenes either engine cannot render are excluded.", "");

  // Detailed tables per group (blend gets its own compact table).
  for (const group of groups) {
    const names = scenes.filter((s) => data.rows.find((r) => r.scene === s)?.group === group);
    push(`### Frame time: ${group}`, "", "| scene | dpr | Skia p50 | Skia p95 | tiny-dist p50 | tiny-dist p95 | tiny-opt3 p50 | tiny-v3 p50 | dist/Skia | spread (MAD) Skia / dist | first frame Skia / dist |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const scene of names) {
      for (const dpr of [1, 2]) {
        const skia = at(scene, dpr, "skia");
        if (!skia) continue;
        const dist = at(scene, dpr, "tiny-dist"), opt = at(scene, dpr, "tiny-opt3"), v3 = at(scene, dpr, "tiny-v3");
        const ratio = skia.cpu && dist?.cpu ? dist.cpu.p50 / skia.cpu.p50 : NaN;
        const within = skia.cpu && dist?.cpu && Math.abs(dist.cpu.p50 - skia.cpu.p50) < 2 * Math.max(skia.cpu.mad, dist.cpu.mad) ? " (within spread)" : "";
        push(`| ${scene} | ${dpr} | ${f(skia.cpu?.p50)} | ${f(skia.cpu?.p95)} | ${dist?.unsupported ? "unsupported" : f(dist?.cpu?.p50)} | ${f(dist?.cpu?.p95)} | ${opt?.unsupported ? "unsupported" : f(opt?.cpu?.p50)} | ${v3?.unsupported ? "unsupported" : f(v3?.cpu?.p50)} | ${f(ratio, 2)}${within} | ${f(skia.cpu?.mad, 3)} / ${f(dist?.cpu?.mad, 3)} | ${f(skia.first_ms, 1)} / ${f(dist?.first_ms, 1)} |`);
      }
    }
    push("");
  }

  // Fidelity.
  push("### Pixel fidelity of tiny-skia (release-dist) against Skia", "", "PSNR over all four premultiplied RGBA8 channels, max channel delta, mean absolute error (levels of 255), and the share of pixels whose largest channel delta exceeds 2 and 16 levels.", "",
    "| scene | dpr | PSNR dB | max delta | mean abs | pixels > 2 | pixels > 16 |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const row of data.fidelity) push(`| ${row.scene} | ${row.dpr} | ${row.psnr === null ? "identical" : f(row.psnr, 2)} | ${row.maxDelta} | ${f(row.meanAbs, 4)} | ${f(row.over2 * 100, 3)}% | ${f(row.over16 * 100, 3)}% |`);
  push("");
  const diffDir = join(resultsDir, "diff");
  if (existsSync(diffDir)) {
    push("### Worst cases (Skia | tiny-skia | amplified x8 difference, 128x128 crop around the worst pixel)", "");
    const worst = [...data.fidelity].filter((r) => r.psnr !== null).sort((a, b) => (a.psnr ?? 0) - (b.psnr ?? 0));
    for (const row of worst.slice(0, 10)) {
      const tag = `${row.scene}@${row.dpr}x`;
      if (!existsSync(join(diffDir, `${tag}-crop.png`))) continue;
      push(`**${tag}**: PSNR ${f(row.psnr ?? undefined, 2)} dB, max delta ${row.maxDelta}, worst pixel (${row.worst.x}, ${row.worst.y})`, "", `![${tag}](${relative(root, join(diffDir, `${tag}-crop.png`)).replaceAll("\\", "/")})`, "");
      if (existsSync(join(diffDir, `${tag}-diff.png`))) push(`Full-frame difference: [${tag}-diff.png](${relative(root, join(diffDir, `${tag}-diff.png`)).replaceAll("\\", "/")})`, "");
    }
  }

  // Memory.
  push("### Peak RSS per process (MiB, max over the run; baseline = RSS before loading the scene)", "", "| scene | dpr | Skia peak | Skia baseline | tiny-dist peak | tiny-dist baseline | tiny-opt3 peak |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const scene of scenes) {
    for (const dpr of [1, 2]) {
      const skia = at(scene, dpr, "skia");
      if (!skia) continue;
      const dist = at(scene, dpr, "tiny-dist"), opt = at(scene, dpr, "tiny-opt3");
      push(`| ${scene} | ${dpr} | ${kb(skia.rss_kb)} | ${kb(skia.rss_baseline_kb)} | ${kb(dist?.rss_kb)} | ${kb(dist?.rss_baseline_kb)} | ${kb(opt?.rss_kb)} |`);
    }
  }
  push("");

  // Size and build.
  const b = data.build;
  if (b?.skia) {
    push("### Binary and library size, build time", "", "| item | value |", "|---|---:|", `| Skia CPU-only static libs (sum of out/Release/*.a) | ${mb(Object.values(b.skia.libs as Record<string, number>).reduce((a, c) => a + c, 0))} |`);
    for (const [name, size] of Object.entries(b.skia.libs as Record<string, number>).sort((a, c) => c[1] - a[1]).slice(0, 8)) push(`| ${name} | ${mb(size)} |`);
    push(`| Skia harness binary, unstripped / stripped (with text: SkShaper + HarfBuzz + ICU + FreeType) | ${mb(b.skia.harness_bytes)} / ${mb(b.skia.harness_stripped_bytes)} |`);
    for (const [id, info] of Object.entries(b.tiny as Record<string, any>)) push(`| ${id} harness binary, unstripped / stripped (tiny-skia + cosmic-text + swash) | ${mb(info.bin_bytes)} / ${mb(info.bin_stripped_bytes)} |`);
    if (b.tiny_notext) push(`| tiny-skia only, no text stack (release-dist, stripped) | ${mb(b.tiny_notext.bin_stripped_bytes)} |`);
    for (const [id, info] of Object.entries(b.tiny as Record<string, any>)) for (const [name, size] of Object.entries(info.rlibs ?? {})) if (id === "tiny-dist") push(`| rlib ${name} (${id}) | ${mb(size as number)} |`);
    push(`| Skia cold build (gn gen + ninja ${b.skia.ninja_steps} steps, load average ${b.loadavg?.[0]?.toFixed(0)}), wall | ${f(b.skia.seconds, 0)} s |`);
    for (const [id, info] of Object.entries(b.tiny as Record<string, any>)) push(`| ${id} cold cargo build (tiny-skia, cosmic-text, swash and the rest of the graph), wall | ${f(info.seconds, 0)} s |`);
    if (b.tiny_notext) push(`| tiny-skia only (no text) cold build, release-dist | ${f(b.tiny_notext.seconds, 0)} s |`);
    push("");
  }

  if (data.pages?.length) {
    push("### Obscura page render (parse, style+layout, paint, PNG encode), 1920x1080 viewport, 1x", "",
      "| page | profile | HTML | parse p50 | style+layout p50 | paint p50 | paint p95 | encode p50 | total p50 | peak RSS | PNG |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const p of data.pages) push(`| ${p.page} | ${p.variant} | ${(p.html_bytes / 1024).toFixed(0)} KiB | ${f(p.parse.p50)} | ${f(p.prepare.p50)} | ${f(p.paint.p50)} | ${f(p.paint.p95)} | ${f(p.encode.p50)} | ${f(p.parse.p50 + p.prepare.p50 + p.paint.p50 + p.encode.p50)} | ${kb(p.rss_kb)} | ${(p.png_bytes / 1024).toFixed(0)} KiB |`);
    push("");
    for (const p of data.pages.filter((x) => x.variant === "tiny-dist")) {
      const png = join(resultsDir, "pages", `${p.page}.png`);
      if (existsSync(png)) push(`![${p.page}](${relative(root, png).replaceAll("\\", "/")})`, "");
    }
  }
  if (data.facts) {
    push("### Feature gaps (measured on this host)", "", "| item | Skia | tiny-skia |", "|---|---|---|");
    for (const [name, value] of Object.entries(data.facts as Record<string, { skia: string; tiny: string }>)) push(`| ${name} | ${value.skia} | ${value.tiny} |`);
    push("");
  }
  void variants;
  return lines;
}
