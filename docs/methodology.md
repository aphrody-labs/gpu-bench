# Methodology

## What is compared

| Suite | Left | Right | Same input |
| --- | --- | --- | --- |
| A | Dawn (`vendor/dawn`, prebuilt release at the pinned commit) | wgpu (`vendor/wgpu`, built from the pinned commit) | the WGSL in `wgsl/` |
| B | three.js `WebGPURenderer` (`vendor/three.js`) | Bevy (`vendor/bevy`) | the scene in `docs/scene.md` |

Submodules are shallow, use relative URLs (`../dawn.git`), and are pinned by commit. `results/*.json` and `RESULTS.md` list the pins and tool versions of the run.

## Suite A hosts

| Host | Dawn side | wgpu side |
| --- | --- | --- |
| Bun | `webgpu` npm package (Dawn Node bindings, prebuilt `dawn.node`) | not available: `bun:wgpu` is not in aphrody-labs/bun, so wgpu is measured through Deno |
| Deno | n/a | `navigator.gpu` (deno_webgpu is built on wgpu) |
| Native | `bench/dawn/main.cpp` linked against `webgpu_dawn.lib` from google/dawn releases | `bench/wgpu` (Rust, path dependency on `vendor/wgpu/wgpu`) |
| Browser | Chrome (Dawn) | Firefox (wgpu), a portable copy under `.tools/firefox` |

The JS hosts run the same file (`js/core.ts`). The two native benches implement the same steps line by line. The numbers are therefore comparable across a row, not across hosts: the host adds its own wait cost to `wall_ms` (Deno and Dawn-node resolve a `mapAsync` through their event loop), while `gpu_ms` comes from timestamp queries around the pass and is host independent.

Backend is pinned per configuration: Dawn takes `backend=d3d12|vulkan` (Node bindings) or `RequestAdapterOptions.backendType` (C++); wgpu takes `Backends::DX12|VULKAN` (Rust). Deno has no backend switch: its default adapter is Vulkan on this machine, and D3D12 is forced by pointing `VK_ICD_FILENAMES` at a missing file. Each result records the adapter description and what was requested.

## Workloads (identical WGSL)

| Name | Definition | Counted time |
| --- | --- | --- |
| `vecadd_64M` | `c = a + b`, 2^26 f32, 256 threads per workgroup, 512 x 512 workgroups | one compute pass |
| `reduce_64M` | two-pass sum of 2^26 f32 (32768 workgroups, then one workgroup) | both dispatches in one pass |
| `matmul_2048` | 2048 x 2048 f32, 16 x 16 shared-memory tiles | one compute pass |
| `cubes_100k_1080p` | 100,000 instanced cubes, 36 vertices each, depth tested, 1920 x 1080 RGBA8 + depth32float, offscreen | one render pass |
| `fullscreen_1080p` | fullscreen triangle, 1024 dependent sin/cos per pixel | one render pass |
| `buffer_create_write_submit_per_s` | create 64 KiB buffer, `writeBuffer`, encode `clearBuffer`, submit, destroy; 5 windows of 500 ms | operations per second per window |
| `shader_module_ms` | `createShaderModule` + `getCompilationInfo`, unique source per iteration | one iteration |
| `render_pipeline_ms` | `createRenderPipeline` (auto layout) on a unique, already compiled module | one iteration |
| `compute_pipeline_ms` | `createComputePipeline` on a unique module | one iteration |

Per workload every run does 5 warmup passes, then 20 (vecadd, matmul), 30 (reduce) or 60 (render) timed passes. Each timed pass is its own submission. Three metrics per pass: `gpu_ms` (timestamp query on the pass), `wall_ms` (encode, submit, wait for the timestamp readback, host clock) and `cpu_ms` (encode and submit only). When the adapter lacks `timestamp-query` the wall time waits on `onSubmittedWorkDone` instead and `gpu_ms` is absent.

Each run verifies its output (first and last 1024 elements of the vector sum, the reduction sum 67108864, five exact matmul entries, and the count of lit pixels for both render workloads).

## Statistics

Each configuration runs 10 times as separate processes (browsers: 10 fresh-profile launches). `RESULTS.md` shows p50, p95 and p99 over all pooled samples (linear interpolation, R-7), plus the min to max and the coefficient of variation of the 10 per-run medians. A difference smaller than the across-run spread is not a result (see the `perf-math` skill).

## Suite B measurement

See `docs/scene.md`. Frame time is uncapped: Chrome runs with `--disable-frame-rate-limit --disable-gpu-vsync`, Bevy uses `PresentMode::AutoNoVsync`. GPU time per frame needs timestamp queries, which perturb timing, so GPU-time runs are separate (3 runs) from the 10 frame-time runs.

## Limits of this setup

- One GPU (RTX 4070), one OS, one power plan (Ultimate Performance); no thermal or clock locking, so the cv column is the honest noise figure.
- Dawn FXC/DXC: the prebuilt Dawn and wgpu both compile HLSL with whatever compiler they find; no `dxcompiler.dll` is shipped next to the benches, so pipeline-creation times compare the default paths, not tuned ones.
- The native Rust and C++ benches are our code, not the engines' own perf suites.
