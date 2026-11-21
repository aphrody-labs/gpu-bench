# Reading results

## Suite A

- Rows are workloads, columns are configurations (`<host>-<engine>-<backend>`). Sections group equal backends.
- `GPU pass time` is the pure GPU duration; for `reduce_64M` it spans both dispatches.
- Derived throughput divides fixed work by the GPU p50: vecadd moves 3 x 268,435,456 B, reduce reads 268,435,456 B, matmul does 2 x 2048^3 FLOP.
- API overhead: higher is better for buffer operations per second, lower for the three creation times. Shader modules are unique per iteration so no cache can answer.
- The correctness table must be identical across columns (same reduction sum, same lit pixel counts within a few pixels of rasterization difference). A column with different checks is a bug, not a result.

## Suite B

- `frame time` uncapped; `fps at p50` is 1000 / p50.
- `main-thread CPU ms per frame` measures the submit side only (render call in three.js, schedule span in Bevy); it is not whole-process CPU.
- `GPU ms per frame` is n/a where no timestamp path exists.
- Startup has two origins: navigation start (web) or process start (native); `native: spawn to first frame` adds process creation and DLL loading.
- GPU memory is a whole-device delta (nvidia-smi) while the process runs, so other GPU users add noise; compare with the idle baseline in mind.
- Shipped bytes: three.js bundle and Bevy wasm are measured after minification/`wasm-opt`, brotli level 11, window 24 bits.
