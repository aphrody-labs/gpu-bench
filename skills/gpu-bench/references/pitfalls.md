# Pitfalls seen while building the suite

- Dawn native (prebuilt static lib) loads `vulkan-1.dll`, `dxcompiler.dll`, `dxil.dll` only from the exe directory: elsewhere `DynamicLib.Open ... Windows Error: 87`. `run.ts setup` stages them into `.bin/`. With vulkan-1.dll staged, native Dawn Vulkan runs.
- Dawn through the `webgpu` npm package cannot load `vulkan-1.dll` on this machine (`DynamicLib.Open: vulkan-1.dll Windows Error: 87`, same under Node); Deno's wgpu loads Vulkan fine. The native Dawn bench result for Vulkan shows whether the prebuilt static library has the same problem.
- Deno ignores `WGPU_BACKEND`; its adapter defaults to Vulkan here (15 features against 12 on D3D12). Hide the Vulkan ICD (`VK_ICD_FILENAMES`, `VK_DRIVER_FILES`) to force D3D12.
- Host wait paths differ: Deno and Dawn-node wall times carry a multi-millisecond event-loop floor; use `gpu_ms` for engine comparisons.
- Dawn's `webgpu_dawn.lib` needs `mincore.lib` for `CompareObjectHandles` besides the D3D and DXGI import libraries.
- Dawn C++ repeatable callbacks (uncaptured error, device lost) cannot capture; use a global.
- Chrome quantizes GPU timestamps unless `--enable-webgpu-developer-features` is set (the harness sets it).
- fr1 is shared: load average above 100 on 12 CPUs happened during this work, so heavy builds were moved to GitHub runners (`--remote actions`).
- Another session adds benchmarks to the same repository (`raster/`); commit explicit paths, never `git add -A`.
- Shader compilers differ by default: Dawn uses DXC (needs dxcompiler.dll + dxil.dll), wgpu uses FXC unless `WGPU_DX12_COMPILER=dxc`. Compare equal compilers or label them.
