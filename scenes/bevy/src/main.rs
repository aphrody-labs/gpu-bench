//! Bevy side of the three.js vs Bevy scene bench (native and wasm+WebGPU). The scene spec is in docs/scene.md and mirrored in scenes/three/main.ts.
//! Native: gpu-bench-bevy --n 10000 [--frames 600] [--warmup 120] [--gpu] --assets <DamagedHelmet/glTF dir>; prints `RESULT {json}` and exits.
//! Web: query string `?n=10000&frames=600&warmup=120&gpu=0`; the result goes to `window.__report(json)`.

use std::time::Instant;

use bevy::{
    asset::AssetPlugin,
    camera::Exposure,
    core_pipeline::tonemapping::Tonemapping,
    diagnostic::DiagnosticsStore,
    light::{CascadeShadowConfigBuilder, DirectionalLightShadowMap},
    prelude::*,
    render::{diagnostic::RenderDiagnosticsPlugin, renderer::RenderAdapterInfo},
    window::{PresentMode, WindowResolution},
    winit::WinitSettings,
};

const SPACING: f32 = 2.2;
const LAYERS: usize = 4;

#[derive(Resource, Clone)]
struct Config {
    n: usize,
    frames: usize,
    warmup: usize,
    gpu: bool,
}

#[derive(Resource)]
struct Bench {
    config: Config,
    frame: usize,
    last: Instant,
    frame_start: Instant,
    process_start: Instant,
    frame_ms: Vec<f64>,
    cpu_ms: Vec<f64>,
    gpu_ms: Vec<f64>,
    first_frame_ms: Option<f64>,
    helmet_frame: Option<usize>,
    helmet_ms: Option<f64>,
    backend: String,
    adapter: String,
}

#[derive(Resource)]
struct Helmet(Handle<Scene>);

fn query(name: &str) -> Option<String> {
    #[cfg(target_arch = "wasm32")]
    {
        let search = web_sys::window()?.location().search().ok()?;
        return search.trim_start_matches('?').split('&').find_map(|pair| pair.split_once('=').filter(|(key, _)| *key == name).map(|(_, value)| value.to_string()));
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let args: Vec<String> = std::env::args().collect();
        let position = args.iter().position(|arg| arg == &format!("--{name}"))?;
        Some(args.get(position + 1).cloned().unwrap_or_else(|| "1".to_string()))
    }
}

/// Milliseconds since the time origin: navigation start on the web, process start natively.
fn since_origin(process_start: Instant) -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        let _ = process_start;
        return web_sys::window().and_then(|window| window.performance()).map(|performance| performance.now()).unwrap_or(0.0);
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        process_start.elapsed().as_secs_f64() * 1000.0
    }
}

fn main() {
    let process_start = Instant::now();
    let number = |name: &str, default: usize| query(name).and_then(|value| value.parse().ok()).unwrap_or(default);
    let config = Config { n: number("n", 1000), frames: number("frames", 600), warmup: number("warmup", 120), gpu: query("gpu").is_some_and(|value| value != "0") };

    let mut window = Window { present_mode: PresentMode::AutoNoVsync, resolution: WindowResolution::new(1920, 1080), title: "gpu-bench".into(), ..default() };
    #[cfg(target_arch = "wasm32")]
    {
        window.canvas = Some("#bevy".to_string());
        window.prevent_default_event_handling = false;
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = &mut window;

    let assets = query("assets").unwrap_or_else(|| "assets".to_string());
    let mut app = App::new();
    app.add_plugins(DefaultPlugins.set(WindowPlugin { primary_window: Some(window), ..default() }).set(AssetPlugin { file_path: assets, ..default() }))
        .insert_resource(WinitSettings::continuous())
        .insert_resource(DirectionalLightShadowMap { size: 2048 })
        .insert_resource(GlobalAmbientLight { color: Color::WHITE, brightness: 300.0, ..default() })
        .insert_resource(ClearColor(Color::srgb(0.1, 0.1, 0.1)))
        .insert_resource(Bench {
            config: config.clone(),
            frame: 0,
            last: process_start,
            frame_start: process_start,
            process_start,
            frame_ms: Vec::new(),
            cpu_ms: Vec::new(),
            gpu_ms: Vec::new(),
            first_frame_ms: None,
            helmet_frame: None,
            helmet_ms: None,
            backend: String::new(),
            adapter: String::new(),
        })
        .insert_resource(config.clone())
        .add_systems(Startup, setup)
        .add_systems(First, frame_start)
        .add_systems(Update, helmet_watch)
        .add_systems(Last, frame_end);
    if config.gpu {
        app.add_plugins(RenderDiagnosticsPlugin);
    }
    app.run();
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut materials: ResMut<Assets<StandardMaterial>>, assets: Res<AssetServer>, config: Res<Config>, mut bench: ResMut<Bench>, info: Option<Res<RenderAdapterInfo>>) {
    if let Some(info) = info {
        bench.backend = format!("{:?}", info.backend);
        bench.adapter = info.name.clone();
    }
    let mesh = meshes.add(Cuboid::new(1.0, 1.0, 1.0));
    let material = materials.add(StandardMaterial { base_color: Color::srgb(0.8, 0.8, 0.8), metallic: 0.5, perceptual_roughness: 0.5, ..default() });
    let side = ((config.n as f32 / LAYERS as f32).sqrt().ceil()) as usize;
    let extent = side as f32 * SPACING;
    for i in 0..config.n {
        let (x, z, y) = (i % side, (i / side) % side, i / (side * side));
        let position = Vec3::new((x as f32 - side as f32 / 2.0) * SPACING, y as f32 * SPACING, (z as f32 - side as f32 / 2.0) * SPACING);
        commands.spawn((Mesh3d(mesh.clone()), MeshMaterial3d(material.clone()), Transform::from_translation(position)));
    }

    let scene: Handle<Scene> = assets.load(GltfAssetLabel::Scene(0).from_asset("DamagedHelmet.gltf"));
    commands.insert_resource(Helmet(scene.clone()));
    commands.spawn((SceneRoot(scene), Transform::from_xyz(0.0, LAYERS as f32 * SPACING + 1.5, 0.0).with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2))));

    commands.spawn((
        DirectionalLight { illuminance: 8000.0, shadow_maps_enabled: true, ..default() },
        Transform::IDENTITY.looking_to(Vec3::new(-0.4, -0.8, -0.5), Vec3::Y),
        CascadeShadowConfigBuilder { num_cascades: 1, first_cascade_far_bound: extent * 2.0, maximum_distance: extent * 2.0, ..default() }.build(),
    ));
    commands.spawn((
        Camera3d::default(),
        Msaa::Off,
        Tonemapping::None,
        Exposure::BLENDER,
        Transform::from_xyz(0.0, 0.45 * extent + 12.0, 0.75 * extent + 20.0).looking_at(Vec3::new(0.0, 3.0, 0.0), Vec3::Y),
    ));
}

fn frame_start(mut bench: ResMut<Bench>) {
    let now = Instant::now();
    if bench.frame > bench.config.warmup {
        let delta = now.duration_since(bench.last).as_secs_f64() * 1000.0;
        bench.frame_ms.push(delta);
    }
    bench.last = now;
    bench.frame_start = now;
    if bench.frame == 2 && bench.first_frame_ms.is_none() {
        bench.first_frame_ms = Some(since_origin(bench.process_start));
        #[cfg(not(target_arch = "wasm32"))]
        println!("FIRST_FRAME");
    }
    if let Some(frame) = bench.helmet_frame {
        if bench.frame == frame + 2 && bench.helmet_ms.is_none() {
            bench.helmet_ms = Some(since_origin(bench.process_start));
            #[cfg(not(target_arch = "wasm32"))]
            println!("HELMET_READY");
        }
    }
}

fn helmet_watch(mut bench: ResMut<Bench>, assets: Res<AssetServer>, helmet: Option<Res<Helmet>>) {
    if bench.helmet_frame.is_none() && helmet.is_some_and(|helmet| assets.is_loaded_with_dependencies(&helmet.0)) {
        bench.helmet_frame = Some(bench.frame);
    }
}

fn frame_end(mut bench: ResMut<Bench>, diagnostics: Res<DiagnosticsStore>, mut exit: MessageWriter<AppExit>) {
    bench.frame += 1;
    if bench.frame <= bench.config.warmup + 1 {
        return;
    }
    let cpu = bench.frame_start.elapsed().as_secs_f64() * 1000.0;
    bench.cpu_ms.push(cpu);
    if bench.config.gpu {
        let paths: Vec<String> = diagnostics.iter().filter(|diagnostic| diagnostic.path().as_str().ends_with("elapsed_gpu")).map(|diagnostic| diagnostic.path().to_string()).collect();
        let leaves = paths.iter().filter(|path| {
            let parent = path.trim_end_matches("/elapsed_gpu");
            !paths.iter().any(|other| other != *path && other.starts_with(&format!("{parent}/")))
        });
        let total: f64 = leaves.filter_map(|path| diagnostics.iter().find(|d| d.path().as_str() == path).and_then(|d| d.value())).sum();
        bench.gpu_ms.push(total);
    }
    if bench.frame_ms.len() >= bench.config.frames {
        let text = serde_json::json!({
            "labels": { "host": if cfg!(target_arch = "wasm32") { "chrome" } else { "native" }, "engine": "bevy", "backend": bench.backend, "adapter": bench.adapter, "bevy": "0.20.1" },
            "config": { "n": bench.config.n, "frames": bench.config.frames, "warmup": bench.config.warmup, "gpu": bench.config.gpu },
            "firstFrameMs": bench.first_frame_ms,
            "helmetMs": bench.helmet_ms,
            "frameMs": bench.frame_ms,
            "cpuMs": bench.cpu_ms,
            "gpuMs": bench.gpu_ms,
        })
        .to_string();
        #[cfg(target_arch = "wasm32")]
        {
            use wasm_bindgen::JsCast;
            if let Some(window) = web_sys::window() {
                if let Ok(callback) = js_sys::Reflect::get(&window, &"__report".into()).and_then(|value| value.dyn_into::<js_sys::Function>().map_err(Into::into)) {
                    let _ = callback.call1(&wasm_bindgen::JsValue::NULL, &text.into());
                }
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        println!("RESULT {text}");
        exit.write(AppExit::Success);
    }
}
