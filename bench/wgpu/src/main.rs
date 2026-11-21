//! wgpu native bench: the same workloads as js/core.ts and bench/dawn/main.cpp.
//! Usage: gpu-bench-wgpu --wgsl <dir> [--backend dx12|vulkan] [--only a,b]; prints one JSON document.

use std::{collections::BTreeMap, path::PathBuf, time::Instant};

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use wgpu::*;

const ELEMENTS: u64 = 1 << 26;
const MATRIX: u64 = 2048;
const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const INSTANCES: u32 = 100_000;
const STORAGE_LIMIT: u64 = 268_435_456;
const WARMUP: usize = 5;

struct Sample {
    cpu: f64,
    wall: f64,
    gpu: Option<f64>,
}

struct Bench {
    device: Device,
    queue: Queue,
    timestamps: Option<(QuerySet, Buffer, Buffer)>,
    metrics: BTreeMap<String, Vec<f64>>,
    checks: BTreeMap<String, Value>,
}

type Encode<'a> = &'a dyn Fn(&mut CommandEncoder, Option<(&QuerySet, u32, u32)>);

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

impl Bench {
    fn push(&mut self, name: &str, value: f64) {
        self.metrics.entry(name.to_string()).or_default().push(value);
    }

    fn record(&mut self, prefix: &str, sample: Sample) {
        self.push(&format!("{prefix}.wall_ms"), sample.wall);
        self.push(&format!("{prefix}.cpu_ms"), sample.cpu);
        if let Some(gpu) = sample.gpu {
            self.push(&format!("{prefix}.gpu_ms"), gpu);
        }
    }

    fn wait(&self) -> Result<()> {
        self.device.poll(PollType::wait_indefinitely())?;
        Ok(())
    }

    fn map_read(&self, buffer: &Buffer, size: u64) -> Result<Vec<u8>> {
        let slice = buffer.slice(0..size);
        slice.map_async(MapMode::Read, |result| {
            if let Err(error) = result {
                eprintln!("map failed: {error}");
            }
        });
        self.wait()?;
        let bytes = slice.get_mapped_range()?.to_vec();
        buffer.unmap();
        Ok(bytes)
    }

    fn measure(&self, encode: Encode) -> Result<Sample> {
        let start = Instant::now();
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let writes = self.timestamps.as_ref().map(|(set, _, _)| (set, 0, 1));
        encode(&mut encoder, writes);
        if let Some((set, resolve, read)) = &self.timestamps {
            encoder.resolve_query_set(set, 0..2, resolve, 0);
            encoder.copy_buffer_to_buffer(resolve, 0, read, 0, 16);
        }
        self.queue.submit([encoder.finish()]);
        let cpu = ms(start);
        let gpu = match &self.timestamps {
            Some((_, _, read)) => {
                let bytes = self.map_read(read, 16)?;
                let ticks: Vec<u64> = bytes.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap_or([0; 8]))).collect();
                Some((ticks[1] - ticks[0]) as f64 * f64::from(self.queue.get_timestamp_period()) / 1e6)
            }
            None => {
                self.wait()?;
                None
            }
        };
        Ok(Sample { cpu, wall: ms(start), gpu })
    }

    fn storage(&self, size: u64) -> Buffer {
        self.device.create_buffer(&BufferDescriptor {
            label: None,
            size,
            usage: BufferUsages::STORAGE | BufferUsages::COPY_SRC | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    fn read_back(&self, source: &Buffer, offset: u64, size: u64) -> Result<Vec<u8>> {
        let staging = self.device.create_buffer(&BufferDescriptor { label: None, size, usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(source, offset, &staging, 0, size);
        self.queue.submit([encoder.finish()]);
        let bytes = self.map_read(&staging, size)?;
        staging.destroy();
        Ok(bytes)
    }

    fn compute(&self, code: &str) -> ComputePipeline {
        let module = self.device.create_shader_module(ShaderModuleDescriptor { label: None, source: ShaderSource::Wgsl(code.to_string().into()) });
        self.device.create_compute_pipeline(&ComputePipelineDescriptor { label: None, layout: None, module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None })
    }

    fn render(&self, module: &ShaderModule, depth: bool) -> RenderPipeline {
        self.device.create_render_pipeline(&RenderPipelineDescriptor {
            label: None,
            layout: None,
            vertex: VertexState { module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(FragmentState { module, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(TextureFormat::Rgba8Unorm.into())] }),
            primitive: PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: depth.then(|| DepthStencilState { format: TextureFormat::Depth32Float, depth_write_enabled: Some(true), depth_compare: Some(CompareFunction::Less), stencil: Default::default(), bias: Default::default() }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    }

    fn module(&self, code: &str) -> ShaderModule {
        self.device.create_shader_module(ShaderModuleDescriptor { label: None, source: ShaderSource::Wgsl(code.to_string().into()) })
    }

    fn lit_pixels(&self, texture: &Texture) -> Result<u64> {
        let size = u64::from(WIDTH) * u64::from(HEIGHT) * 4;
        let staging = self.device.create_buffer(&BufferDescriptor { label: None, size, usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            TexelCopyBufferInfo { buffer: &staging, layout: TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(WIDTH * 4), rows_per_image: Some(HEIGHT) } },
            Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
        let bytes = self.map_read(&staging, size)?;
        staging.destroy();
        Ok(bytes.chunks_exact(4).filter(|p| *p != [0, 0, 0, 255]).count() as u64)
    }
}

fn bind(device: &Device, layout: &BindGroupLayout, buffers: &[&Buffer]) -> BindGroup {
    let entries: Vec<BindGroupEntry> = buffers.iter().enumerate().map(|(binding, buffer)| BindGroupEntry { binding: binding as u32, resource: buffer.as_entire_binding() }).collect();
    device.create_bind_group(&BindGroupDescriptor { label: None, layout, entries: &entries })
}

fn dispatch<'a>(pipeline: &'a ComputePipeline, groups: [u32; 3], group: &'a BindGroup) -> impl Fn(&mut CommandEncoder, Option<(&QuerySet, u32, u32)>) + 'a {
    move |encoder, writes| {
        let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
            label: None,
            timestamp_writes: writes.map(|(query_set, begin, end)| ComputePassTimestampWrites { query_set, beginning_of_pass_write_index: Some(begin), end_of_pass_write_index: Some(end) }),
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, group, &[]);
        pass.dispatch_workgroups(groups[0], groups[1], groups[2]);
    }
}

fn unique(code: &str, i: i64) -> String {
    code.replace("const SEED = 0u;", &format!("const SEED = {}u;", i + 1))
}

fn run(dir: PathBuf, backend: &str, only: Option<Vec<String>>) -> Result<Value> {
    let wanted = |name: &str| only.as_ref().is_none_or(|list| list.iter().any(|item| item == name));
    let backends = match backend {
        "dx12" => Backends::DX12,
        "vulkan" => Backends::VULKAN,
        other => return Err(anyhow!("unknown backend {other}")),
    };
    let mut descriptor = InstanceDescriptor::new_without_display_handle();
    descriptor.backends = backends;
    let instance = Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&RequestAdapterOptions { power_preference: PowerPreference::HighPerformance, ..Default::default() }))?;
    let info = adapter.get_info();
    let timestamp_query = adapter.features().contains(Features::TIMESTAMP_QUERY);
    let limits = Limits { max_storage_buffer_binding_size: STORAGE_LIMIT as u32, max_buffer_size: STORAGE_LIMIT, ..Limits::default() };
    let (device, queue) = pollster::block_on(adapter.request_device(&DeviceDescriptor {
        label: None,
        required_features: if timestamp_query { Features::TIMESTAMP_QUERY } else { Features::empty() },
        required_limits: limits,
        experimental_features: ExperimentalFeatures::disabled(),
        memory_hints: MemoryHints::Performance,
        trace: Trace::Off,
    }))?;
    let errors = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    {
        let errors = errors.clone();
        device.on_uncaptured_error(std::sync::Arc::new(move |error: wgpu::Error| {
            if let Ok(mut list) = errors.lock() {
                list.push(error.to_string());
            }
        }));
    }

    let timestamps = timestamp_query.then(|| {
        let set = device.create_query_set(&QuerySetDescriptor { label: None, ty: QueryType::Timestamp, count: 2 });
        let resolve = device.create_buffer(&BufferDescriptor { label: None, size: 16, usage: BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC, mapped_at_creation: false });
        let read = device.create_buffer(&BufferDescriptor { label: None, size: 16, usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST, mapped_at_creation: false });
        (set, resolve, read)
    });
    let mut bench = Bench { device, queue, timestamps, metrics: BTreeMap::new(), checks: BTreeMap::new() };
    let source = |name: &str| std::fs::read_to_string(dir.join(format!("{name}.wgsl"))).with_context(|| format!("read {name}.wgsl"));
    let (init, vecadd, matinit, matmul, reduce1, reduce2, cubes, fullscreen) = (source("init")?, source("vecadd")?, source("matinit")?, source("matmul")?, source("reduce1")?, source("reduce2")?, source("cubes")?, source("fullscreen")?);

    let bytes = ELEMENTS * 4;
    if wanted("vecadd") || wanted("reduce") {
        let (a, b, c) = (bench.storage(bytes), bench.storage(bytes), bench.storage(bytes));
        let init_pipeline = bench.compute(&init);
        let init_group = bind(&bench.device, &init_pipeline.get_bind_group_layout(0), &[&a, &b]);
        bench.measure(&dispatch(&init_pipeline, [512, 512, 1], &init_group))?;

        if wanted("vecadd") {
            let pipeline = bench.compute(&vecadd);
            let group = bind(&bench.device, &pipeline.get_bind_group_layout(0), &[&a, &b, &c]);
            let encode = dispatch(&pipeline, [512, 512, 1], &group);
            for _ in 0..WARMUP {
                bench.measure(&encode)?;
            }
            for _ in 0..20 {
                let sample = bench.measure(&encode)?;
                bench.record("vecadd_64M", sample);
            }
            let floats = |raw: Vec<u8>| -> Vec<f32> { raw.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap_or([0; 4]))).collect() };
            let head = floats(bench.read_back(&c, 0, 4096)?);
            let tail = floats(bench.read_back(&c, bytes - 4096, 4096)?);
            let expected = |i: u64| ((i & 1023) + 1) as f32;
            let ok = head.iter().enumerate().all(|(i, v)| *v == expected(i as u64)) && tail.iter().enumerate().all(|(i, v)| *v == expected(ELEMENTS - 1024 + i as u64));
            bench.checks.insert("vecadd_ok".into(), json!(ok));
        }
        if wanted("reduce") {
            let (partials, result) = (bench.storage(32768 * 4), bench.storage(4));
            let (pass1, pass2) = (bench.compute(&reduce1), bench.compute(&reduce2));
            let group1 = bind(&bench.device, &pass1.get_bind_group_layout(0), &[&b, &partials]);
            let group2 = bind(&bench.device, &pass2.get_bind_group_layout(0), &[&partials, &result]);
            let encode = |encoder: &mut CommandEncoder, writes: Option<(&QuerySet, u32, u32)>| {
                let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
                    label: None,
                    timestamp_writes: writes.map(|(query_set, begin, end)| ComputePassTimestampWrites { query_set, beginning_of_pass_write_index: Some(begin), end_of_pass_write_index: Some(end) }),
                });
                pass.set_pipeline(&pass1);
                pass.set_bind_group(0, &group1, &[]);
                pass.dispatch_workgroups(32768, 1, 1);
                pass.set_pipeline(&pass2);
                pass.set_bind_group(0, &group2, &[]);
                pass.dispatch_workgroups(1, 1, 1);
            };
            for _ in 0..WARMUP {
                bench.measure(&encode)?;
            }
            for _ in 0..30 {
                let sample = bench.measure(&encode)?;
                bench.record("reduce_64M", sample);
            }
            let sum = f32::from_le_bytes(bench.read_back(&result, 0, 4)?.try_into().unwrap_or([0; 4]));
            bench.checks.insert("reduce_sum".into(), json!(sum));
            bench.checks.insert("reduce_ok".into(), json!(sum as u64 == ELEMENTS));
        }
    }

    if wanted("matmul") {
        let size = MATRIX * MATRIX * 4;
        let (a, b, c) = (bench.storage(size), bench.storage(size), bench.storage(size));
        let init_pipeline = bench.compute(&matinit);
        let init_group = bind(&bench.device, &init_pipeline.get_bind_group_layout(0), &[&a, &b]);
        bench.measure(&dispatch(&init_pipeline, [128, 128, 1], &init_group))?;
        let pipeline = bench.compute(&matmul);
        let group = bind(&bench.device, &pipeline.get_bind_group_layout(0), &[&a, &b, &c]);
        let encode = dispatch(&pipeline, [128, 128, 1], &group);
        for _ in 0..WARMUP {
            bench.measure(&encode)?;
        }
        for _ in 0..20 {
            let sample = bench.measure(&encode)?;
            bench.record("matmul_2048", sample);
        }
        let out: Vec<f32> = bench.read_back(&c, 0, size)?.chunks_exact(4).map(|v| f32::from_le_bytes(v.try_into().unwrap_or([0; 4]))).collect();
        let n = MATRIX as usize;
        let ok = [(0usize, 0usize), (1, 2047), (1023, 1024), (2047, 2047), (700, 33)].iter().all(|&(i, j)| {
            let sum: usize = (0..n).map(|k| ((i + 2 * k) % 5) * ((3 * k + j) % 7)).sum();
            out[i * n + j] == sum as f32
        });
        bench.checks.insert("matmul_ok".into(), json!(ok));
    }

    let color = bench.device.create_texture(&TextureDescriptor {
        label: None,
        size: Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let depth = bench.device.create_texture(&TextureDescriptor {
        label: None,
        size: Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Depth32Float,
        usage: TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let color_view = color.create_view(&Default::default());
    let depth_view = depth.create_view(&Default::default());
    let draw = |pipeline: &RenderPipeline, group: Option<&BindGroup>, vertices: u32, instances: u32, with_depth: bool| {
        let (color_view, depth_view, pipeline, group) = (&color_view, &depth_view, pipeline.clone(), group.cloned());
        move |encoder: &mut CommandEncoder, writes: Option<(&QuerySet, u32, u32)>| {
            let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(RenderPassColorAttachment { view: color_view, depth_slice: None, resolve_target: None, ops: Operations { load: LoadOp::Clear(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }), store: StoreOp::Store } })],
                depth_stencil_attachment: with_depth.then_some(RenderPassDepthStencilAttachment { view: depth_view, depth_ops: Some(Operations { load: LoadOp::Clear(1.0), store: StoreOp::Store }), stencil_ops: None }),
                timestamp_writes: writes.map(|(query_set, begin, end)| RenderPassTimestampWrites { query_set, beginning_of_pass_write_index: Some(begin), end_of_pass_write_index: Some(end) }),
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            if let Some(group) = &group {
                pass.set_bind_group(0, group, &[]);
            }
            pass.draw(0..vertices, 0..instances);
        }
    };

    if wanted("cubes") {
        let mut data = vec![0f32; INSTANCES as usize * 4];
        for i in 0..INSTANCES as usize {
            data[i * 4] = ((i % 100) * 3) as f32;
            data[i * 4 + 1] = (((i / 100) % 100) * 3) as f32;
            data[i * 4 + 2] = ((i / 10000) * 3) as f32;
            data[i * 4 + 3] = 1.0 + (i % 3) as f32 * 0.1;
        }
        let instances = bench.storage(data.len() as u64 * 4);
        bench.queue.write_buffer(&instances, 0, &data.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
        let pipeline = bench.render(&bench.module(&cubes), true);
        let group = bind(&bench.device, &pipeline.get_bind_group_layout(0), &[&instances]);
        let encode = draw(&pipeline, Some(&group), 36, INSTANCES, true);
        for _ in 0..WARMUP {
            bench.measure(&encode)?;
        }
        for _ in 0..60 {
            let sample = bench.measure(&encode)?;
            bench.record("cubes_100k_1080p", sample);
        }
        let lit = bench.lit_pixels(&color)?;
        bench.checks.insert("cubes_lit_pixels".into(), json!(lit));
    }
    if wanted("fullscreen") {
        let pipeline = bench.render(&bench.module(&fullscreen), false);
        let encode = draw(&pipeline, None, 3, 1, false);
        for _ in 0..WARMUP {
            bench.measure(&encode)?;
        }
        for _ in 0..60 {
            let sample = bench.measure(&encode)?;
            bench.record("fullscreen_1080p", sample);
        }
        let lit = bench.lit_pixels(&color)?;
        bench.checks.insert("fullscreen_lit_pixels".into(), json!(lit));
    }

    if wanted("api") {
        let payload = vec![0u8; 65536];
        for _ in 0..5 {
            let (mut operations, start) = (0u64, Instant::now());
            while ms(start) < 500.0 {
                let buffer = bench.device.create_buffer(&BufferDescriptor { label: None, size: 65536, usage: BufferUsages::COPY_DST | BufferUsages::STORAGE, mapped_at_creation: false });
                bench.queue.write_buffer(&buffer, 0, &payload);
                let mut encoder = bench.device.create_command_encoder(&Default::default());
                encoder.clear_buffer(&buffer, 0, Some(256));
                bench.queue.submit([encoder.finish()]);
                buffer.destroy();
                operations += 1;
                if operations % 256 == 0 {
                    bench.wait()?;
                }
            }
            bench.wait()?;
            bench.push("buffer_create_write_submit_per_s", operations as f64 * 1000.0 / ms(start));
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        for i in -2i64..20 {
            let code = unique(&matmul, i + 1000);
            let start = Instant::now();
            let module = bench.module(&code);
            pollster::block_on(module.get_compilation_info());
            if i >= 0 {
                bench.push("shader_module_ms", ms(start));
            }
        }
        for i in -2i64..15 {
            let module = bench.module(&unique(&cubes, i + 2000));
            pollster::block_on(module.get_compilation_info());
            let start = Instant::now();
            let _pipeline = bench.render(&module, true);
            if i >= 0 {
                bench.push("render_pipeline_ms", ms(start));
            }
        }
        for i in -2i64..15 {
            let module = bench.module(&unique(&matmul, i + 3000));
            pollster::block_on(module.get_compilation_info());
            let start = Instant::now();
            let _pipeline = bench.device.create_compute_pipeline(&ComputePipelineDescriptor { label: None, layout: None, module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
            if i >= 0 {
                bench.push("compute_pipeline_ms", ms(start));
            }
        }
    }

    bench.wait()?;
    let errors = errors.lock().map(|list| list.clone()).unwrap_or_default();
    Ok(json!({
        "labels": { "host": "native", "engine": "wgpu", "runtime": format!("wgpu {} (rust {})", env!("CARGO_PKG_VERSION"), option_env!("RUSTC_VERSION").unwrap_or("?")), "requestedBackend": backend, "backend": format!("{:?}", info.backend) },
        "adapter": { "vendor": info.vendor, "device": info.device, "description": info.name, "driver": info.driver, "driverInfo": info.driver_info },
        "features": { "timestampQuery": timestamp_query },
        "errors": errors,
        "metrics": bench.metrics,
        "checks": bench.checks,
    }))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let option = |name: &str| args.iter().position(|a| a == &format!("--{name}")).and_then(|i| args.get(i + 1)).cloned();
    let dir = PathBuf::from(option("wgsl").context("--wgsl <dir> is required")?);
    let backend = option("backend").unwrap_or_else(|| "dx12".to_string());
    let only = option("only").map(|list| list.split(',').map(str::to_string).collect());
    println!("{}", run(dir, &backend, only)?);
    Ok(())
}
