# Scene spec (suite B)

Both engines build this scene. `scenes/three/main.ts` and `scenes/bevy/src/main.rs` mirror each other.

- Canvas / window: 1920 x 1080 logical pixels at the native devicePixelRatio (three.js: `setPixelRatio(devicePixelRatio)`; Bevy: native scale factor). Presentation is uncapped.
- Cubes: N in {1,000; 10,000; 100,000}, unit `Cuboid`/`BoxGeometry`, one shared PBR material (white-grey, metalness 0.5, roughness 0.5). Layout: 4 layers, `side = ceil(sqrt(N / 4))`, spacing 2.2, centred on x and z.
  - three.js: one `InstancedMesh` with N instances.
  - Bevy: N entities sharing one mesh and one material; Bevy batches them into instanced draws automatically (the idiomatic path, so the per-entity ECS cost is part of what is measured).
- Model: Khronos DamagedHelmet glTF (`vendor/three.js/examples/models/gltf/DamagedHelmet/glTF`, served to both), placed above the slab, rotated +90 degrees about x.
- Light: one directional light with shadows, 2048 x 2048 shadow map, one cascade covering the slab (Bevy `CascadeShadowConfigBuilder`, three.js orthographic shadow camera), plus a global ambient light.
- Camera: perspective, 50 degrees, at `(0, 0.45 * extent + 12, 0.75 * extent + 20)` looking at `(0, 3, 0)`, `extent = side * 2.2`.
- Anti-aliasing off (three.js `antialias: false`, Bevy `Msaa::Off`), tone mapping off.
- three.js: `WebGPURenderer` with `forceWebGL: false`, built from the fork's `build/three.webgpu.js`.
- Bevy: native (Windows, wgpu) and wasm32 + WebGPU in Chrome (feature `webgpu`, no WebGL2 fallback).

## Metrics

| Metric | three.js | Bevy |
| --- | --- | --- |
| frame time | delta between `setAnimationLoop` callbacks | delta between `First` schedule runs |
| main-thread CPU ms per frame | `renderer.render()` duration | `First` to `Last` schedule span |
| GPU ms per frame | `renderer.resolveTimestampsAsync(RENDER)` (`trackTimestamp`) | `RenderDiagnosticsPlugin`, sum of leaf `elapsed_gpu` (Vulkan or DX12 only; not available in the browser build) |
| startup to first frame | `performance.now()` at the second frame (time origin = navigation start) | native: since `main` starts, plus an external clock from process spawn; web: `performance.now()` at the second frame |
| startup to helmet | second frame after the glTF resolved | second frame after `is_loaded_with_dependencies` |
| GPU memory | `nvidia-smi` memory.used peak above idle baseline, sampled every 150 ms while the process runs (the whole Chrome GPU process for browser runs) | same |
| shipped bytes | `bun build --minify` bundle, raw and brotli level 11 | wasm after `wasm-opt -O3`, JS glue, and the native exe, raw and brotli |

Warmup: 60 frames. Measured: 600 frames or 20 s, whichever comes first (at least 30 frames).
