// One workload definition for every JS host: Bun (Dawn through the `webgpu` package), Deno (wgpu) and browsers (Dawn in Chrome, wgpu in Firefox).
// A host supplies the GPU object and a WGSL loader; everything measured here is identical across hosts. Times are milliseconds.

export interface Host {
  gpu: GPU;
  wgsl(name: string): Promise<string>;
  /** Free-form labels recorded next to the numbers (runtime, version, requested backend, ...). */
  labels: Record<string, string>;
}
export interface RunResult {
  labels: Record<string, string>;
  adapter: Record<string, unknown>;
  features: { timestampQuery: boolean };
  errors: string[];
  metrics: Record<string, number[]>;
  checks: Record<string, unknown>;
}

export const SIZES = { elements: 1 << 26, matrix: 2048, width: 1920, height: 1080, instances: 100_000 };
const ITERATIONS = { vecadd: 20, matmul: 20, reduce: 30, cubes: 60, fullscreen: 60, pipelines: 15, modules: 20, bufferWindows: 5, bufferWindowMs: 500 };
const WARMUP = 5;
const STORAGE_LIMIT = 268_435_456;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Timer {
  private readonly querySet?: GPUQuerySet;
  private readonly resolveBuffer?: GPUBuffer;
  private readonly readBuffer?: GPUBuffer;
  constructor(private readonly device: GPUDevice, enabled: boolean) {
    if (!enabled) return;
    this.querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    this.resolveBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }
  /** Encodes one pass, submits it and waits for completion. `cpu` is encode+submit, `wall` includes the wait, `gpu` is the pass duration. */
  async measure(encode: (encoder: GPUCommandEncoder, writes: GPUComputePassTimestampWrites | undefined) => void) {
    const t0 = performance.now();
    const encoder = this.device.createCommandEncoder();
    const writes = this.querySet && { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    encode(encoder, writes);
    if (this.querySet && this.resolveBuffer && this.readBuffer) {
      encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
      encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, 16);
    }
    this.device.queue.submit([encoder.finish()]);
    const cpu = performance.now() - t0;
    let gpu: number | undefined;
    if (this.readBuffer) {
      await this.readBuffer.mapAsync(GPUMapMode.READ);
      const stamps = new BigInt64Array(this.readBuffer.getMappedRange().slice(0));
      this.readBuffer.unmap();
      gpu = Number(stamps[1]! - stamps[0]!) / 1e6;
    } else {
      await this.device.queue.onSubmittedWorkDone();
    }
    return { cpu, wall: performance.now() - t0, gpu };
  }
}

export async function runAll(host: Host, only?: Set<string>): Promise<RunResult> {
  const adapter = await host.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const info = adapter.info;
  const timestampQuery = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({
    requiredFeatures: timestampQuery ? ["timestamp-query"] : [],
    requiredLimits: { maxStorageBufferBindingSize: STORAGE_LIMIT, maxBufferSize: STORAGE_LIMIT },
  });
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (event) => errors.push(String((event as GPUUncapturedErrorEvent).error.message)));
  void device.lost.then((lost) => errors.push(`device lost: ${lost.reason} ${lost.message}`));

  const metrics: Record<string, number[]> = {};
  const checks: Record<string, unknown> = {};
  const push = (name: string, value: number | undefined) => {
    if (value !== undefined) (metrics[name] ??= []).push(value);
  };
  const timer = new Timer(device, timestampQuery);
  const wanted = (name: string) => !only || only.has(name);

  const sources = Object.fromEntries(
    await Promise.all(["init", "vecadd", "matinit", "matmul", "reduce1", "reduce2", "cubes", "fullscreen"].map(async (name) => [name, await host.wgsl(name)])),
  ) as Record<string, string>;
  const compute = (code: string) => device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
  const bind = (pipeline: GPUComputePipeline | GPURenderPipeline, ...buffers: GPUBuffer[]) =>
    device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const storage = (size: number, extra = 0) => device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra });
  const readBack = async (source: GPUBuffer, offset: number, size: number) => {
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, offset, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const bytes = staging.getMappedRange().slice(0);
    staging.destroy();
    return bytes;
  };
  const record = (prefix: string, sample: { cpu: number; wall: number; gpu?: number }) => {
    push(`${prefix}.wall_ms`, sample.wall);
    push(`${prefix}.cpu_ms`, sample.cpu);
    push(`${prefix}.gpu_ms`, sample.gpu);
  };
  const dispatch = (pipeline: GPUComputePipeline, groups: [number, number, number], bindGroup: GPUBindGroup) =>
    (encoder: GPUCommandEncoder, writes: GPUComputePassTimestampWrites | undefined) => {
      const pass = encoder.beginComputePass({ timestampWrites: writes });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(...groups);
      pass.end();
    };

  // ---- compute: vector add and reduction share the 64M-element buffers -------------------------------------------
  const bytes = SIZES.elements * 4;
  if (wanted("vecadd") || wanted("reduce")) {
    const a = storage(bytes);
    const b = storage(bytes);
    const c = storage(bytes);
    const initPipeline = compute(sources.init!);
    await timer.measure(dispatch(initPipeline, [512, 512, 1], bind(initPipeline, a, b)));

    if (wanted("vecadd")) {
      const pipeline = compute(sources.vecadd!);
      const group = bind(pipeline, a, b, c);
      for (let i = 0; i < WARMUP; i++) await timer.measure(dispatch(pipeline, [512, 512, 1], group));
      for (let i = 0; i < ITERATIONS.vecadd; i++) record("vecadd_64M", await timer.measure(dispatch(pipeline, [512, 512, 1], group)));
      const head = new Float32Array(await readBack(c, 0, 4096));
      const tail = new Float32Array(await readBack(c, bytes - 4096, 4096));
      const expected = (i: number) => (i & 1023) + 1;
      checks.vecadd_ok = head.every((v, i) => v === expected(i)) && tail.every((v, i) => v === expected(SIZES.elements - 1024 + i));
    }
    if (wanted("reduce")) {
      const partials = storage(32768 * 4);
      const result = storage(4);
      const pass1 = compute(sources.reduce1!);
      const pass2 = compute(sources.reduce2!);
      const group1 = bind(pass1, b, partials);
      const group2 = bind(pass2, partials, result);
      const encode = (encoder: GPUCommandEncoder, writes: GPUComputePassTimestampWrites | undefined) => {
        const pass = encoder.beginComputePass({ timestampWrites: writes });
        pass.setPipeline(pass1);
        pass.setBindGroup(0, group1);
        pass.dispatchWorkgroups(32768);
        pass.setPipeline(pass2);
        pass.setBindGroup(0, group2);
        pass.dispatchWorkgroups(1);
        pass.end();
      };
      for (let i = 0; i < WARMUP; i++) await timer.measure(encode);
      for (let i = 0; i < ITERATIONS.reduce; i++) record("reduce_64M", await timer.measure(encode));
      checks.reduce_sum = new Float32Array(await readBack(result, 0, 4))[0];
      checks.reduce_ok = checks.reduce_sum === SIZES.elements;
      partials.destroy();
      result.destroy();
    }
    for (const buffer of [a, b, c]) buffer.destroy();
  }

  if (wanted("matmul")) {
    const n = SIZES.matrix;
    const a = storage(n * n * 4);
    const b = storage(n * n * 4);
    const c = storage(n * n * 4);
    const initPipeline = compute(sources.matinit!);
    await timer.measure(dispatch(initPipeline, [128, 128, 1], bind(initPipeline, a, b)));
    const pipeline = compute(sources.matmul!);
    const group = bind(pipeline, a, b, c);
    for (let i = 0; i < WARMUP; i++) await timer.measure(dispatch(pipeline, [128, 128, 1], group));
    for (let i = 0; i < ITERATIONS.matmul; i++) record("matmul_2048", await timer.measure(dispatch(pipeline, [128, 128, 1], group)));
    const probes: Array<[number, number]> = [[0, 0], [1, 2047], [1023, 1024], [2047, 2047], [700, 33]];
    const out = new Float32Array(await readBack(c, 0, n * n * 4));
    checks.matmul_ok = probes.every(([i, j]) => {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += ((i + 2 * k) % 5) * ((3 * k + j) % 7);
      return out[i * n + j] === sum;
    });
    for (const buffer of [a, b, c]) buffer.destroy();
  }

  // ---- render --------------------------------------------------------------------------------------------------
  const { width, height } = SIZES;
  const color = device.createTexture({ size: [width, height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const depth = device.createTexture({ size: [width, height], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const renderPipeline = (code: string, withDepth: boolean) =>
    device.createRenderPipeline({
      layout: "auto",
      vertex: { module: device.createShaderModule({ code }), entryPoint: "vs" },
      fragment: { module: device.createShaderModule({ code }), entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: withDepth ? { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" } : undefined,
    });
  const draw = (pipeline: GPURenderPipeline, bindGroup: GPUBindGroup | undefined, vertices: number, instances: number, withDepth: boolean) =>
    (encoder: GPUCommandEncoder, writes: GPUComputePassTimestampWrites | undefined) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: color.createView(), clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }],
        depthStencilAttachment: withDepth ? { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } : undefined,
        timestampWrites: writes,
      });
      pass.setPipeline(pipeline);
      if (bindGroup) pass.setBindGroup(0, bindGroup);
      pass.draw(vertices, instances);
      pass.end();
    };

  if (wanted("cubes")) {
    const count = SIZES.instances;
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      data[i * 4] = (i % 100) * 3;
      data[i * 4 + 1] = (Math.floor(i / 100) % 100) * 3;
      data[i * 4 + 2] = Math.floor(i / 10000) * 3;
      data[i * 4 + 3] = 1 + (i % 3) * 0.1;
    }
    const instances = storage(data.byteLength);
    device.queue.writeBuffer(instances, 0, data);
    const pipeline = renderPipeline(sources.cubes!, true);
    const group = bind(pipeline, instances);
    const encode = draw(pipeline, group, 36, count, true);
    for (let i = 0; i < WARMUP; i++) await timer.measure(encode);
    for (let i = 0; i < ITERATIONS.cubes; i++) record("cubes_100k_1080p", await timer.measure(encode));
    checks.cubes_lit_pixels = await litPixels(device, color);
    instances.destroy();
  }
  if (wanted("fullscreen")) {
    const pipeline = renderPipeline(sources.fullscreen!, false);
    const encode = draw(pipeline, undefined, 3, 1, false);
    for (let i = 0; i < WARMUP; i++) await timer.measure(encode);
    for (let i = 0; i < ITERATIONS.fullscreen; i++) record("fullscreen_1080p", await timer.measure(encode));
    checks.fullscreen_lit_pixels = await litPixels(device, color);
  }

  // ---- API overhead ---------------------------------------------------------------------------------------------
  if (wanted("api")) {
    const payload = new Uint8Array(65536);
    for (let window = 0; window < ITERATIONS.bufferWindows; window++) {
      let operations = 0;
      const start = performance.now();
      while (performance.now() - start < ITERATIONS.bufferWindowMs) {
        const buffer = device.createBuffer({ size: payload.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE });
        device.queue.writeBuffer(buffer, 0, payload);
        const encoder = device.createCommandEncoder();
        encoder.clearBuffer(buffer, 0, 256);
        device.queue.submit([encoder.finish()]);
        buffer.destroy();
        operations++;
        if (operations % 256 === 0) await device.queue.onSubmittedWorkDone();
      }
      await device.queue.onSubmittedWorkDone();
      push("buffer_create_write_submit_per_s", (operations * 1000) / (performance.now() - start));
      await sleep(10);
    }
    const unique = (code: string, i: number) => code.replace("const SEED = 0u;", `const SEED = ${i + 1}u;`);
    const trivial = (i: number) => unique(sources.matmul!, i);
    for (let i = -2; i < ITERATIONS.modules; i++) {
      const code = trivial(i + 1000);
      const t0 = performance.now();
      const module = device.createShaderModule({ code });
      await module.getCompilationInfo();
      if (i >= 0) push("shader_module_ms", performance.now() - t0);
    }
    for (let i = -2; i < ITERATIONS.pipelines; i++) {
      const code = unique(sources.cubes!, i + 2000);
      const module = device.createShaderModule({ code });
      await module.getCompilationInfo();
      const t0 = performance.now();
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
      });
      if (i >= 0) push("render_pipeline_ms", performance.now() - t0);
    }
    for (let i = -2; i < ITERATIONS.pipelines; i++) {
      const module = device.createShaderModule({ code: trivial(i + 3000) });
      await module.getCompilationInfo();
      const t0 = performance.now();
      device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      if (i >= 0) push("compute_pipeline_ms", performance.now() - t0);
    }
  }

  await device.queue.onSubmittedWorkDone();
  return {
    labels: host.labels,
    adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description },
    features: { timestampQuery },
    errors,
    metrics,
    checks,
  };
}

/** Number of pixels that differ from the clear colour (0,0,0,1), read back once per workload as a sanity check. */
async function litPixels(device: GPUDevice, texture: GPUTexture): Promise<number> {
  const bytesPerRow = SIZES.width * 4;
  const staging = device.createBuffer({ size: bytesPerRow * SIZES.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, [SIZES.width, SIZES.height]);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const pixels = new Uint32Array(staging.getMappedRange().slice(0));
  staging.destroy();
  let lit = 0;
  for (const pixel of pixels) if (pixel !== 0xff000000) lit++;
  return lit;
}
