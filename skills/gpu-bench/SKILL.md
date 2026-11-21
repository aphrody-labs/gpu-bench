---
name: gpu-bench
description: "Run and read gpu-bench: Dawn vs wgpu (compute, render, API overhead; Bun, Deno, native, browsers) and three.js vs Bevy. Use before claiming a WebGPU speedup or picking Dawn or wgpu."
---

# gpu-bench

Repository: `C:\src\gpu-bench` (`aphrody-labs/gpu-bench`). Forks `dawn`, `wgpu`, `three.js`, `bevy` are shallow submodules under `vendor/` pinned by commit. Results: `RESULTS.md` (generated) and `results/**/*.json` (raw per-run samples).

## Run it

```
bun scripts/run.ts setup                 # shallow submodules, JS deps, bundles
bun scripts/run.ts build                 # fr1 (cargo-xwin, clang-cl, wasm32) -> .bin/ ; add --remote actions when fr1 is saturated
bun scripts/run.ts bench a               # Dawn vs wgpu (10 runs per config)
bun scripts/run.ts bench b               # three.js vs Bevy (10 perf runs + 3 GPU-timestamp runs per config)
bun scripts/run.ts sizes && bun scripts/run.ts report
```

Single configuration: `bun scripts/run.ts bench native-wgpu-dx12 --runs 3`; ids come from `bun scripts/run.ts list`. Builds need the commit pushed to `origin/main` (fr1 and Actions build the pushed commit). Heavy compiles never run on the PC; GPU runs only on the local RTX 4070. Details: `references/commands.md`.

## Read it

- Cells are `p50 / p95 / p99` of all pooled samples, then min-max and cv of the per-run medians. A gap smaller than the across-run spread is noise.
- `gpu_ms` (timestamp query) is host independent: use it to compare engines. `wall_ms` includes each host's wait path (Deno and Dawn-node resolve `mapAsync` through their event loops), so compare wall only inside one host column set.
- Compare equal backends only: Dawn d3d12 with wgpu dx12, Dawn vulkan with wgpu vulkan. Deno defaults to Vulkan; D3D12 is forced by hiding the Vulkan ICD.
- Suite B frame time is uncapped (no vsync). GPU ms per frame comes from separate runs because timestamp queries perturb frame time. Bevy's browser build has no GPU time (WebGPU timestamps are not wired in its diagnostics).
- Always read `Could not run` and the configuration table first: a missing column is a recorded failure, not a zero.

More: `references/reading-results.md` (metrics, derived throughput), `references/pitfalls.md` (what broke and why).

## Change it

- New workload: add `wgsl/<name>.wgsl`, then the same step in `js/core.ts`, `bench/wgpu/src/main.rs` and `bench/dawn/main.cpp`; the three must stay line-for-line equivalent and verify their output.
- New fork pin: `git -C vendor/<name> fetch --depth 1 origin <sha> && git -C vendor/<name> checkout <sha>`, commit the gitlink, rerun everything. Dawn's pin must match a google/dawn release (the prebuilt static library is fetched by commit).
- Before claiming a speedup apply the `perf-math` skill: state the number, report runs and spread.
