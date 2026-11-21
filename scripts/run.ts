#!/usr/bin/env bun
// Rebuilds and reruns every benchmark. Builds happen on fr1 (cargo-xwin, clang-cl, wasm32); runs happen on this machine's GPU.
//   bun scripts/run.ts setup                     init submodules (shallow), install JS deps, fetch the Dawn prebuilt, bundle pages
//   bun scripts/run.ts build [target...]         targets: wgpu dawn bevy-native bevy-web three js   (default: all)
//   bun scripts/run.ts bench <suite|config>...   suites: a, b; or config ids (see `list`)
//   bun scripts/run.ts list                      print config ids
//   bun scripts/run.ts sizes                     shipped bytes (minified, brotli) into results/sizes.json
//   bun scripts/run.ts report                    regenerate RESULTS.md from results/*.json
//   options: --runs N (default 10 perf runs; GPU-timestamp runs default 3)
import { existsSync, statSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import { $ } from "bun";
import { BIN, FR1_DIR, RESULTS, capture, ensureDir, fr1, log, machine, path, pins, withGpuMemory, writeJson } from "./lib/common.ts";
import { type BrowserKind, inBrowser, lastJson, runNative, startServer } from "./lib/host.ts";

const argv = Bun.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? Number(argv[at + 1]) : fallback;
};
const positional = argv.filter((arg, index) => !arg.startsWith("--") && !(index > 0 && argv[index - 1]!.startsWith("--") && argv[index - 1] !== "--help"));
const [command = "help", ...targets] = positional;
const RUNS = flag("runs", 10);
const GPU_RUNS = flag("gpu-runs", 3);

const exe = (name: string) => path(".bin", name);
const brotli = (bytes: Uint8Array) => brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 } }).length;

// ---- configurations -----------------------------------------------------------------------------------------------

interface SuiteA {
  id: string;
  title: string;
  run: (server: ReturnType<typeof startServer>) => Promise<unknown>;
}
const NO_VULKAN = { VK_ICD_FILENAMES: "C:\\nonexistent-icd.json", VK_DRIVER_FILES: "C:\\nonexistent-icd.json" };
const json = async (command: string[], env?: Record<string, string>) => lastJson((await runNative(command, { env, timeoutMs: 300_000 })).stdout);
const A_CONFIGS: SuiteA[] = [
  { id: "bun-dawn-d3d12", title: "Bun + webgpu (Dawn) D3D12", run: () => json(["bun", "js/bun.ts", "--backend", "d3d12"]) },
  { id: "bun-dawn-vulkan", title: "Bun + webgpu (Dawn) Vulkan", run: () => json(["bun", "js/bun.ts", "--backend", "vulkan"]) },
  { id: "deno-wgpu-vulkan", title: "Deno (wgpu) Vulkan", run: () => json(["deno", "run", "-A", "--unstable-webgpu", "js/deno.ts", "--backend", "vulkan"]) },
  { id: "deno-wgpu-dx12", title: "Deno (wgpu) D3D12", run: () => json(["deno", "run", "-A", "--unstable-webgpu", "js/deno.ts", "--backend", "dx12"], NO_VULKAN) },
  { id: "native-dawn-d3d12", title: "Native Dawn C++ D3D12", run: () => json([exe("gpu-bench-dawn.exe"), "--wgsl", "wgsl", "--backend", "d3d12"]) },
  { id: "native-dawn-vulkan", title: "Native Dawn C++ Vulkan", run: () => json([exe("gpu-bench-dawn.exe"), "--wgsl", "wgsl", "--backend", "vulkan"]) },
  { id: "native-wgpu-dx12", title: "Native wgpu Rust D3D12", run: () => json([exe("gpu-bench-wgpu.exe"), "--wgsl", "wgsl", "--backend", "dx12"]) },
  { id: "native-wgpu-vulkan", title: "Native wgpu Rust Vulkan", run: () => json([exe("gpu-bench-wgpu.exe"), "--wgsl", "wgsl", "--backend", "vulkan"]) },
  { id: "chrome-dawn", title: "Chrome (Dawn, D3D12 default)", run: async (server) => JSON.parse((await inBrowser("chrome", server, `${server.url}/browser?browser=chrome&engine=dawn`, 300_000)).text) },
  { id: "firefox-wgpu", title: "Firefox (wgpu)", run: async (server) => JSON.parse((await inBrowser("firefox", server, `${server.url}/browser?browser=firefox&engine=wgpu`, 300_000)).text) },
];

const SIZES = [1000, 10000, 100000];
interface SuiteB {
  id: string;
  title: string;
  gpuKind: boolean;
  run: (server: ReturnType<typeof startServer>, gpu: boolean) => Promise<Record<string, unknown>>;
}
const sceneArgs = (n: number, gpu: boolean) => ["--n", String(n), "--gpu", gpu ? "1" : "0"];
const B_CONFIGS: SuiteB[] = SIZES.flatMap((n) => [
  {
    id: `three-chrome-n${n}`,
    title: `three.js WebGPURenderer, Chrome, ${n} cubes`,
    gpuKind: true,
    run: async (server, gpu) => {
      const { value, peakDeltaMiB } = await withGpuMemory(async () => inBrowser("chrome", server, `${server.url}/three?n=${n}&gpu=${gpu ? 1 : 0}`, 240_000));
      return { ...JSON.parse(value.text), peakGpuMiB: peakDeltaMiB };
    },
  },
  {
    id: `bevy-native-n${n}`,
    title: `Bevy native (wgpu), ${n} cubes`,
    gpuKind: true,
    run: async (_server, gpu) => {
      const helmet = path("vendor", "three.js", "examples", "models", "gltf", "DamagedHelmet", "glTF");
      const { value, peakDeltaMiB } = await withGpuMemory(() => runNative([exe("gpu-bench-bevy.exe"), ...sceneArgs(n, gpu), "--assets", helmet], { timeoutMs: 240_000 }));
      return { ...(lastJson(value.stdout) as object), externalFirstFrameMs: value.markers.FIRST_FRAME, externalHelmetMs: value.markers.HELMET_READY, peakGpuMiB: peakDeltaMiB };
    },
  },
  {
    id: `bevy-web-n${n}`,
    title: `Bevy wasm + WebGPU, Chrome, ${n} cubes`,
    gpuKind: false,
    run: async (server) => {
      const { value, peakDeltaMiB } = await withGpuMemory(async () => inBrowser("chrome", server, `${server.url}/bevy?n=${n}&assets=assets`, 240_000));
      return { ...JSON.parse(value.text), peakGpuMiB: peakDeltaMiB };
    },
  },
]);

// ---- commands -----------------------------------------------------------------------------------------------------

async function setup() {
  await capture(["git", "submodule", "update", "--init", "--depth", "1"]);
  await $`bun install`.cwd(path("js"));
  ensureDir(BIN);
  await build(["js", "three"]);
}

async function syncFr1(submodules: string[]) {
  const head = (await capture(["git", "rev-parse", "HEAD"])).trim();
  const dirty = (await capture(["git", "status", "--porcelain", "--", ".", ":!.tools", ":!.bin", ":!.tmp"])).trim();
  if (dirty) throw new Error(`commit and push first, fr1 builds the pushed commit:\n${dirty}`);
  await capture(["git", "fetch", "-q", "origin", "main"]);
  const remote = (await capture(["git", "rev-parse", "origin/main"])).trim();
  if (remote !== head) throw new Error(`push first: HEAD ${head} is not origin/main ${remote}`);
  const modules = submodules.map((name) => `vendor/${name}`).join(" ");
  await fr1(`mkdir -p ~/gpu-bench && (test -d ${FR1_DIR}/.git || git clone -q https://github.com/aphrody-labs/gpu-bench.git ${FR1_DIR}) && cd ${FR1_DIR} && git fetch -q origin && git checkout -q -f ${head} && git submodule update --init --depth 1 ${modules}`);
  return head;
}

const WIN = "x86_64-pc-windows-msvc";
async function fetchFromFr1(remote: string, local: string) {
  ensureDir(BIN);
  await capture(["scp", "-q", "-r", `fr1:${remote}`, local]);
}

const BUILDERS: Record<string, () => Promise<void>> = {
  async js() {
    await $`bun build js/browser.ts --outdir dist --target browser --minify`.cwd(path());
  },
  async three() {
    await $`bun build scenes/three/main.ts --outdir dist --entry-naming three-scene.js --target browser --minify --tsconfig-override scenes/three/tsconfig.json`.cwd(path());
  },
  async wgpu() {
    await syncFr1(["wgpu"]);
    await fr1(`cd ${FR1_DIR}/bench/wgpu && cargo xwin build --release --target ${WIN}`);
    await fetchFromFr1(`${FR1_DIR}/bench/wgpu/target/${WIN}/release/gpu-bench-wgpu.exe`, BIN);
  },
  async dawn() {
    await syncFr1([]);
    const release = (await capture(["gh", "api", "repos/aphrody-labs/dawn/commits/" + (await pins()).dawn, "--jq", ".sha"])).trim();
    log(`dawn pin ${release}`);
    const tag = (await capture(["gh", "api", "repos/google/dawn/releases", "--paginate", "--jq", `.[] | select(.assets[].name | contains("${release}")) | .tag_name`])).trim().split("\n")[0]!;
    const asset = `Dawn-${release}-windows-latest-Release.tar.gz`;
    const tools = "~/gpu-bench/tools/dawn-rel";
    await fr1(`mkdir -p ${tools} && cd ${tools} && (test -d Dawn-${release}-windows-latest-Release || (curl -sfL -o dawn.tar.gz https://github.com/google/dawn/releases/download/${tag}/${asset} && tar xzf dawn.tar.gz))`);
    const script = `
set -e
D=$(ls -d ${tools}/Dawn-${release}-windows-latest-Release)
X=$HOME/.cache/cargo-xwin/xwin
cd ${FR1_DIR}/bench/dawn
clang-cl --target=${WIN} /std:c++20 /O2 /EHsc /MD /DNOMINMAX /imsvc $X/crt/include /imsvc $X/sdk/include/ucrt /imsvc $X/sdk/include/um /imsvc $X/sdk/include/shared \\
  /I$D/include main.cpp /Fe:gpu-bench-dawn.exe -fuse-ld=lld-link /link /libpath:$X/crt/lib/x86_64 /libpath:$X/sdk/lib/um/x86_64 /libpath:$X/sdk/lib/ucrt/x86_64 \\
  $D/lib/webgpu_dawn.lib user32.lib gdi32.lib dxgi.lib d3d12.lib d3d11.lib dxguid.lib ole32.lib advapi32.lib shell32.lib ws2_32.lib dbghelp.lib kernelbase.lib version.lib`;
    await fr1(script);
    await fetchFromFr1(`${FR1_DIR}/bench/dawn/gpu-bench-dawn.exe`, BIN);
  },
  async "bevy-native"() {
    await syncFr1(["bevy"]);
    await fr1(`cd ${FR1_DIR}/scenes/bevy && cargo xwin build --release --target ${WIN} --features native`);
    await fetchFromFr1(`${FR1_DIR}/scenes/bevy/target/${WIN}/release/gpu-bench-bevy.exe`, BIN);
  },
  async "bevy-web"() {
    await syncFr1(["bevy"]);
    await fr1(`cd ${FR1_DIR}/scenes/bevy && cargo build --release --target wasm32-unknown-unknown --features web && rm -rf web-dist && wasm-bindgen --target web --no-typescript --out-dir web-dist target/wasm32-unknown-unknown/release/gpu_bench_bevy.wasm && wasm-opt -O3 --all-features -o web-dist/gpu_bench_bevy_bg.wasm web-dist/gpu_bench_bevy_bg.wasm`);
    await $`rm -rf ${path(".bin", "bevy-web")}`;
    await fetchFromFr1(`${FR1_DIR}/scenes/bevy/web-dist`, path(".bin", "bevy-web"));
  },
};

const REMOTE = argv.includes("--remote") ? argv[argv.indexOf("--remote") + 1] : "fr1";

/** GitHub Actions fallback for fr1 builds: dispatches build.yml for the target, waits, downloads the artifact into .bin. */
async function buildOnActions(name: string) {
  const head = (await syncCheck());
  await capture(["gh", "workflow", "run", "build.yml", "--repo", "aphrody-labs/gpu-bench", "--ref", "main", "-f", `target=${name}`]);
  await Bun.sleep(8000);
  const runId = (await capture(["gh", "run", "list", "--repo", "aphrody-labs/gpu-bench", "--workflow", "build.yml", "--limit", "1", "--json", "databaseId,headSha", "--jq", ".[0].databaseId"])).trim();
  log(`actions run ${runId} for ${head}`);
  await capture(["gh", "run", "watch", runId, "--repo", "aphrody-labs/gpu-bench", "--exit-status"], { timeoutMs: 7_200_000 });
  const target = name === "bevy-web" ? path(".bin", "bevy-web") : BIN;
  await capture(["gh", "run", "download", runId, "--repo", "aphrody-labs/gpu-bench", "-n", name, "-D", target]);
}
async function syncCheck() {
  const head = (await capture(["git", "rev-parse", "HEAD"])).trim();
  await capture(["git", "fetch", "-q", "origin", "main"]);
  if ((await capture(["git", "rev-parse", "origin/main"])).trim() !== head) throw new Error("push first: actions builds origin/main");
  return head;
}

async function build(names: string[]) {
  ensureDir(BIN);
  for (const name of names.length ? names : Object.keys(BUILDERS)) {
    const builder = BUILDERS[name];
    if (!builder) throw new Error(`unknown build target ${name}; known: ${Object.keys(BUILDERS).join(" ")}`);
    log(`build ${name} (${["js", "three"].includes(name) ? "local bundle" : REMOTE})`);
    if (REMOTE === "actions" && !["js", "three"].includes(name)) await buildOnActions(name);
    else await builder();
  }
}

async function bench(selection: string[]) {
  const wantA = selection.includes("a") || selection.length === 0;
  const wantB = selection.includes("b") || selection.length === 0;
  const server = startServer();
  const meta = async () => ({ machine: await machine(), pins: await pins() });
  try {
    for (const config of A_CONFIGS) {
      if (!(wantA || selection.includes(config.id))) continue;
      const runs: unknown[] = [];
      try {
        for (let run = 0; run < RUNS; run++) {
          log(`${config.id} run ${run + 1}/${RUNS}`);
          runs.push(await config.run(server));
          await Bun.sleep(1500);
        }
      } catch (error) {
        log(`${config.id} failed: ${String(error).slice(0, 400)}`);
        if (runs.length === 0) {
          await writeJson(path("results", "a", `${config.id}.json`), { id: config.id, title: config.title, meta: await meta(), failed: String(error).slice(0, 2000), runs: [] });
          continue;
        }
      }
      await writeJson(path("results", "a", `${config.id}.json`), { id: config.id, title: config.title, meta: await meta(), runs });
    }
    for (const config of B_CONFIGS) {
      if (!(wantB || selection.includes(config.id))) continue;
      const result: Record<string, unknown> = { id: config.id, title: config.title, meta: await meta(), perf: [] as unknown[], gpu: [] as unknown[] };
      try {
        for (let run = 0; run < RUNS; run++) {
          log(`${config.id} perf ${run + 1}/${RUNS}`);
          (result.perf as unknown[]).push(await config.run(server, false));
          await Bun.sleep(1500);
        }
        if (config.gpuKind) {
          for (let run = 0; run < GPU_RUNS; run++) {
            log(`${config.id} gpu ${run + 1}/${GPU_RUNS}`);
            (result.gpu as unknown[]).push(await config.run(server, true));
            await Bun.sleep(1500);
          }
        }
      } catch (error) {
        log(`${config.id} failed: ${String(error).slice(0, 400)}`);
        result.failed = String(error).slice(0, 2000);
      }
      await writeJson(path("results", "b", `${config.id}.json`), result);
    }
  } finally {
    server.stop();
  }
}

async function sizes() {
  const entry = async (file: string) => {
    if (!existsSync(file)) return undefined;
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    return { raw: statSync(file).size, brotli: brotli(bytes) };
  };
  const helmetDir = path("vendor", "three.js", "examples", "models", "gltf", "DamagedHelmet", "glTF");
  let helmet = 0;
  for (const name of ["DamagedHelmet.gltf", "DamagedHelmet.bin", "Default_albedo.jpg", "Default_AO.jpg", "Default_emissive.jpg", "Default_metalRoughness.jpg", "Default_normal.jpg"]) helmet += statSync(path(helmetDir, name)).size;
  await writeJson(path("results", "sizes.json"), {
    three_bundle_min: await entry(path("dist", "three-scene.js")),
    bevy_wasm: await entry(path(".bin", "bevy-web", "gpu_bench_bevy_bg.wasm")),
    bevy_js_glue: await entry(path(".bin", "bevy-web", "gpu_bench_bevy.js")),
    bevy_native_exe: await entry(path(".bin", "gpu-bench-bevy.exe")),
    wgpu_native_exe: await entry(path(".bin", "gpu-bench-wgpu.exe")),
    dawn_native_exe: await entry(path(".bin", "gpu-bench-dawn.exe")),
    helmet_assets_raw: helmet,
  });
}

switch (command) {
  case "setup":
    await setup();
    break;
  case "build":
    await build(targets);
    break;
  case "bench":
    await bench(targets);
    break;
  case "sizes":
    await sizes();
    break;
  case "report":
    await $`bun scripts/report.ts`.cwd(path());
    break;
  case "list":
    console.log([...A_CONFIGS, ...B_CONFIGS].map((config) => config.id).join("\n"));
    break;
  default:
    console.log("usage: bun scripts/run.ts setup | build [target...] | bench <a|b|config>... | sizes | report | list   (--runs N, --gpu-runs N)");
}
void RESULTS;
