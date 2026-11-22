> **Moved.** This repository has been consolidated into [aphrody-labs/fw](https://github.com/aphrody-labs/fw/tree/main/gpu-bench) (\$(System.Collections.Hashtable.sub)\ — WebGPU (Dawn vs wgpu) and 3D (three.js vs Bevy) benchmarks (skill in plugins/aphrody/skills/gpu-bench)) and archived. All active development continues in \phrody-labs/fw\.

# gpu-bench

Reproducible WebGPU benchmarks on one machine, with the engines as pinned submodules:

- **A. Dawn vs wgpu**: the same WGSL (vector add over 64M f32, 2048 x 2048 matmul, parallel reduction, 100k instanced cubes at 1080p, a fragment-bound fullscreen pass) plus API overhead (buffer create+write+submit per second, pipeline and shader-module creation), from Bun, Deno, native (C++ and Rust) and browsers.
- **B. three.js vs Bevy**: the same scene (N instanced PBR cubes, DamagedHelmet, one shadowed directional light) with three.js `WebGPURenderer` in Chrome, Bevy native, and Bevy wasm + WebGPU in Chrome.

Numbers: [RESULTS.md](RESULTS.md) (generated). Raw samples: `results/**/*.json`. Method: [docs/methodology.md](docs/methodology.md), scene: [docs/scene.md](docs/scene.md). Agent skill: `skills/gpu-bench` (installed through the `aphrody` plugin of the `fw` marketplace).

## Layout

| Path | Content |
| --- | --- |
| `vendor/{dawn,wgpu,three.js,bevy}` | forks as shallow submodules, relative URLs (`../dawn.git` ...), pinned commits |
| `wgsl/` | the shared WGSL workloads |
| `js/` | `core.ts` (workloads), `bun.ts`, `deno.ts`, `browser.ts` hosts |
| `bench/wgpu`, `bench/dawn` | native benches (Rust on wgpu, C++ on Dawn's prebuilt static library) |
| `scenes/three`, `scenes/bevy` | suite B scenes |
| `scripts/run.ts`, `scripts/report.ts` | build, run, report |
| `.github/workflows/build.yml` | Windows and wasm builds on GitHub runners (fallback when fr1 is saturated) |

## Exact commands

Prerequisites on the PC (GPU runs only): Bun, Deno, Chrome, `gh` logged in, `ssh fr1` working. Firefox is optional: extract the official installer with 7-Zip into `.tools/firefox` (`7z x firefox-setup.exe -o.tools/firefox-ex`, move `firefox-ex` to `firefox`).

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/aphrody-labs/gpu-bench.git
cd gpu-bench
bun scripts/run.ts setup                      # shallow submodules, js deps, bundle pages

# builds: fr1 compiles (cargo-xwin, clang-cl, wasm32); commit and push first, fr1 builds origin/main
bun scripts/run.ts build wgpu dawn bevy-native bevy-web
bun scripts/run.ts build --remote actions wgpu dawn bevy-native bevy-web   # same on GitHub runners
bun scripts/run.ts sizes                      # shipped bytes -> results/sizes.json

# runs: local RTX 4070 only, 10 runs per configuration (3 more for GPU-timestamp runs in suite B)
bun scripts/run.ts bench a
bun scripts/run.ts bench b
bun scripts/run.ts bench native-wgpu-dx12 --runs 3     # one configuration
bun scripts/run.ts list                                # configuration ids

bun scripts/run.ts report                              # writes RESULTS.md
```

Direct invocations used by the harness:

```sh
bun js/bun.ts --backend d3d12                                         # Dawn from Bun (npm: webgpu)
deno run -A --unstable-webgpu js/deno.ts --backend vulkan             # wgpu from Deno
.bin/gpu-bench-dawn.exe --wgsl wgsl --backend d3d12                   # Dawn native
.bin/gpu-bench-wgpu.exe --wgsl wgsl --backend dx12                    # wgpu native
.bin/gpu-bench-bevy.exe --n 10000 --gpu 0 --assets vendor/three.js/examples/models/gltf/DamagedHelmet/glTF
```

## Pins

`git submodule status` lists the pinned commits; `RESULTS.md` repeats them with the tool versions. Dawn is pinned to the commit of a google/dawn release so the prebuilt static library matches the source; wgpu to `wgpu-v30.0.2`; Bevy to `v0.20.1`; three.js to the fork's `main` at the pinned commit.
