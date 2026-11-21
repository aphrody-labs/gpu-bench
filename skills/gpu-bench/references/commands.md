# Commands

| Task | Command |
| --- | --- |
| Init submodules (shallow, relative URLs) | `git submodule update --init --depth 1 vendor/dawn vendor/wgpu vendor/three.js vendor/bevy` |
| Build wgpu Rust bench (Windows exe) | `bun scripts/run.ts build wgpu` (fr1: `cargo xwin build --release --target x86_64-pc-windows-msvc`) |
| Build Dawn C++ bench | `bun scripts/run.ts build dawn` (fr1: clang-cl against the `webgpu_dawn.lib` of google/dawn release `Dawn-<sha>-windows-latest-Release`) |
| Build Bevy native / wasm | `bun scripts/run.ts build bevy-native`, `bun scripts/run.ts build bevy-web` (wasm-bindgen 0.2.130, `wasm-opt -O3`) |
| Same on GitHub runners | `bun scripts/run.ts build --remote actions <target>` (workflow `.github/workflows/build.yml`, artifacts land in `.bin/`) |
| Bundle pages | `bun scripts/run.ts build js three` |
| Run | `bun scripts/run.ts bench a`, `bench b`, `bench <id>` |
| Report | `bun scripts/run.ts sizes && bun scripts/run.ts report` |

Machines: `fr1` builds (12 CPU, shared and often loaded; check `uptime` first), the PC runs GPU work, `fr2` is out of service. Firefox is a portable copy extracted from the official installer into `.tools/firefox` (not committed).

Dawn prebuilt check: `gh api repos/google/dawn/releases --jq '.[0].assets[].name'`; the submodule pin must equal the `<sha>` in an asset name.
