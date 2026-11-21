// tiny-skia CPU raster harness: plays a .scene file (grammar in raster/scenes.ts) and prints per-frame timings as JSON.
use std::collections::HashMap;
use std::fs;
use std::path::Path as FsPath;
use std::rc::Rc;
use std::time::Instant;

use tiny_skia::{
    BlendMode, Color, FillRule, FilterQuality, GradientStop, IntSize, LineCap, LineJoin, LinearGradient, Mask, Paint, Path, PathBuilder,
    Pattern, Pixmap, Point, RadialGradient, Rect, Shader, SpreadMode, Stroke, StrokeDash, SweepGradient, Transform,
};

const BLEND_NAMES: [&str; 29] = [
    "clear", "src", "dst", "srcover", "dstover", "srcin", "dstin", "srcout", "dstout", "srcatop", "dstatop", "xor", "plus", "modulate", "screen",
    "overlay", "darken", "lighten", "colordodge", "colorburn", "hardlight", "softlight", "difference", "exclusion", "multiply", "hue", "saturation",
    "color", "luminosity",
];
const BLEND_MODES: [BlendMode; 29] = [
    BlendMode::Clear, BlendMode::Source, BlendMode::Destination, BlendMode::SourceOver, BlendMode::DestinationOver, BlendMode::SourceIn,
    BlendMode::DestinationIn, BlendMode::SourceOut, BlendMode::DestinationOut, BlendMode::SourceAtop, BlendMode::DestinationAtop, BlendMode::Xor,
    BlendMode::Plus, BlendMode::Modulate, BlendMode::Screen, BlendMode::Overlay, BlendMode::Darken, BlendMode::Lighten, BlendMode::ColorDodge,
    BlendMode::ColorBurn, BlendMode::HardLight, BlendMode::SoftLight, BlendMode::Difference, BlendMode::Exclusion, BlendMode::Multiply, BlendMode::Hue,
    BlendMode::Saturation, BlendMode::Color, BlendMode::Luminosity,
];

struct Op {
    kind: String,
    tokens: Vec<String>,
    text: String,
}

#[derive(Default)]
struct Scene {
    width: u32,
    height: u32,
    shape_every_frame: bool,
    paths: HashMap<String, Path>,
    images: HashMap<String, Pixmap>,
    font: Option<Vec<u8>>,
    ops: Vec<Op>,
}

fn number(token: &str) -> f32 {
    token.parse().unwrap_or(0.0)
}

fn parse_path(tokens: &[String]) -> Option<Path> {
    let mut builder = PathBuilder::new();
    let mut i = 0;
    let next = |i: &mut usize| {
        *i += 1;
        number(&tokens[*i - 1])
    };
    while i < tokens.len() {
        let command = tokens[i].as_str();
        i += 1;
        match command {
            "M" => { let (x, y) = (next(&mut i), next(&mut i)); builder.move_to(x, y); }
            "L" => { let (x, y) = (next(&mut i), next(&mut i)); builder.line_to(x, y); }
            "Q" => { let (a, b, c, d) = (next(&mut i), next(&mut i), next(&mut i), next(&mut i)); builder.quad_to(a, b, c, d); }
            "C" => {
                let (a, b, c, d, e, f) = (next(&mut i), next(&mut i), next(&mut i), next(&mut i), next(&mut i), next(&mut i));
                builder.cubic_to(a, b, c, d, e, f);
            }
            "Z" => builder.close(),
            _ => {}
        }
    }
    builder.finish()
}

fn spread(name: &str) -> SpreadMode {
    match name {
        "repeat" => SpreadMode::Repeat,
        "reflect" => SpreadMode::Reflect,
        _ => SpreadMode::Pad,
    }
}

/// Builds the shader for a paint spec starting at `tokens[*i]`; advances `*i`.
fn make_shader(tokens: &[String], i: &mut usize) -> Option<Shader<'static>> {
    let kind = tokens[*i].as_str();
    *i += 1;
    let mut next = |i: &mut usize| {
        *i += 1;
        number(&tokens[*i - 1])
    };
    let color = |i: &mut usize, next: &mut dyn FnMut(&mut usize) -> f32| {
        let (r, g, b, a) = (next(i), next(i), next(i), next(i));
        Color::from_rgba8(r as u8, g as u8, b as u8, a as u8)
    };
    if kind == "solid" {
        return Some(Shader::SolidColor(color(i, &mut next)));
    }
    let count = match kind { "lin" => 4, "rad" => 3, "rad2" => 6, _ => 4 };
    let mut v = [0.0f32; 8];
    for slot in v.iter_mut().take(count) {
        *slot = next(i);
    }
    let mode = spread(&tokens[*i]);
    *i += 1;
    let stops_count = tokens[*i].parse::<usize>().ok()?;
    *i += 1;
    let mut stops = Vec::with_capacity(stops_count);
    for _ in 0..stops_count {
        let position = next(i);
        stops.push(GradientStop::new(position, color(i, &mut next)));
    }
    let identity = Transform::identity();
    match kind {
        "lin" => LinearGradient::new(Point::from_xy(v[0], v[1]), Point::from_xy(v[2], v[3]), stops, mode, identity),
        "rad" => {
            let center = Point::from_xy(v[0], v[1]);
            RadialGradient::new(center, 0.0, center, v[2], stops, mode, identity)
        }
        "rad2" => RadialGradient::new(Point::from_xy(v[0], v[1]), v[2], Point::from_xy(v[3], v[4]), v[5], stops, mode, identity),
        _ => SweepGradient::new(Point::from_xy(v[0], v[1]), v[2], v[3], stops, mode, identity),
    }
}

#[cfg(unix)]
fn thread_cpu_ms() -> f64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as f64 * 1e3 + ts.tv_nsec as f64 / 1e6
}
#[cfg(not(unix))]
fn thread_cpu_ms() -> f64 {
    0.0
}

#[cfg(unix)]
fn max_rss_kb() -> i64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    usage.ru_maxrss
}
#[cfg(not(unix))]
fn max_rss_kb() -> i64 {
    0
}

#[cfg(feature = "text")]
mod text {
    use super::*;
    use cosmic_text::{fontdb, Attrs, Buffer, Family, FontSystem, Metrics, Shaping, SwashCache};

    pub struct Text {
        pub font_system: FontSystem,
        pub swash: SwashCache,
        pub family: String,
        pub cache: HashMap<usize, Buffer>,
    }

    impl Text {
        pub fn new(font: &[u8]) -> Text {
            let mut database = fontdb::Database::new();
            database.load_font_data(font.to_vec());
            let family = database.faces().next().and_then(|face| face.families.first().map(|(name, _)| name.clone())).unwrap_or_default();
            Text { font_system: FontSystem::new_with_locale_and_db("en-US".to_string(), database), swash: SwashCache::new(), family, cache: HashMap::new() }
        }

        fn shape(&mut self, size: f32, line: &str) -> Buffer {
            let mut buffer = Buffer::new(&mut self.font_system, Metrics::new(size, size * 1.2));
            buffer.set_size(&mut self.font_system, None, None);
            buffer.set_text(&mut self.font_system, line, &Attrs::new().family(Family::Name(&self.family)), Shaping::Advanced);
            buffer.shape_until_scroll(&mut self.font_system, false);
            buffer
        }

        /// Draws one baseline-anchored line; compositing is Obscura's scalar source-over into the premultiplied pixels.
        pub fn draw(&mut self, pixmap: &mut Pixmap, index: usize, shape_each_frame: bool, size: f32, x: f32, baseline: f32, rgba: [u8; 4], line: &str) -> Result<(), String> {
            let fresh;
            let buffer = if shape_each_frame {
                fresh = self.shape(size, line);
                &fresh
            } else {
                if !self.cache.contains_key(&index) {
                    let buffer = self.shape(size, line);
                    self.cache.insert(index, buffer);
                }
                &self.cache[&index]
            };
            let width = pixmap.width() as i32;
            let height = pixmap.height() as i32;
            let pixels = pixmap.pixels_mut();
            let color = cosmic_text::Color::rgba(rgba[0], rgba[1], rgba[2], rgba[3]);
            for run in buffer.layout_runs() {
                for glyph in run.glyphs.iter() {
                    let physical = glyph.physical((x, baseline - run.line_y), 1.0);
                    self.swash.with_pixels(&mut self.font_system, physical.cache_key, color, |dx, dy, glyph_color| {
                        let (px, py) = (physical.x + dx, run.line_y as i32 + physical.y + dy);
                        if px < 0 || px >= width || py < 0 || py >= height {
                            return;
                        }
                        let alpha = glyph_color.a() as u32;
                        if alpha == 0 {
                            return;
                        }
                        let slot = (py * width + px) as usize;
                        let destination = pixels[slot];
                        let inverse = 255 - alpha;
                        let out_alpha = alpha + destination.alpha() as u32 * inverse / 255;
                        let out_red = glyph_color.r() as u32 * alpha / 255 + destination.red() as u32 * inverse / 255;
                        let out_green = glyph_color.g() as u32 * alpha / 255 + destination.green() as u32 * inverse / 255;
                        let out_blue = glyph_color.b() as u32 * alpha / 255 + destination.blue() as u32 * inverse / 255;
                        pixels[slot] = tiny_skia::PremultipliedColorU8::from_rgba(out_red as u8, out_green as u8, out_blue as u8, out_alpha as u8).unwrap_or(destination);
                    });
                }
            }
            Ok(())
        }
    }
}

#[cfg(not(feature = "text"))]
mod text {
    use super::*;

    pub struct Text;

    impl Text {
        pub fn new(_font: &[u8]) -> Text {
            Text
        }

        #[allow(clippy::too_many_arguments)]
        pub fn draw(&mut self, _pixmap: &mut Pixmap, _index: usize, _shape_each_frame: bool, _size: f32, _x: f32, _baseline: f32, _rgba: [u8; 4], _line: &str) -> Result<(), String> {
            Err("unsupported text".to_string())
        }
    }
}

struct Frame {
    pixmap: Pixmap,
    base: Transform,
    dpr: f32,
}

fn play(scene: &Scene, frame: &mut Frame, text: &mut Option<text::Text>) -> Result<(), String> {
    let mut transform = Transform::identity();
    let mut blend = BlendMode::SourceOver;
    let mut clip: Option<Rc<Mask>> = None;
    let mut saved: Vec<Option<Rc<Mask>>> = Vec::new();
    let (width, height) = (frame.pixmap.width(), frame.pixmap.height());
    for (index, op) in scene.ops.iter().enumerate() {
        let t = &op.tokens;
        let total = frame.base.pre_concat(transform);
        match op.kind.as_str() {
            "clear" => frame.pixmap.fill(Color::from_rgba8(number(&t[0]) as u8, number(&t[1]) as u8, number(&t[2]) as u8, number(&t[3]) as u8)),
            "save" => saved.push(clip.clone()),
            "restore" => clip = saved.pop().unwrap_or(None),
            "xf" => transform = Transform::from_row(number(&t[0]), number(&t[1]), number(&t[2]), number(&t[3]), number(&t[4]), number(&t[5])),
            "blend" => {
                if let Some(k) = BLEND_NAMES.iter().position(|name| *name == t[0]) {
                    blend = BLEND_MODES[k];
                }
            }
            "clip" => {
                let path = &scene.paths[&t[0]];
                let anti_alias = t[1] == "1";
                let mut mask = match &clip {
                    Some(existing) => (**existing).clone(),
                    None => {
                        let mut fresh = Mask::new(width, height).ok_or("mask")?;
                        fresh.fill_path(path, FillRule::Winding, anti_alias, total);
                        clip = Some(Rc::new(fresh));
                        continue;
                    }
                };
                mask.intersect_path(path, FillRule::Winding, anti_alias, total);
                clip = Some(Rc::new(mask));
            }
            "fill" | "rect" => {
                let (anti_alias, mut i) = if op.kind == "fill" { (t[2] == "1", 3) } else { (t[4] == "1", 5) };
                let Some(shader) = make_shader(t, &mut i) else { continue };
                let paint = Paint { shader, blend_mode: blend, anti_alias, force_hq_pipeline: false, ..Paint::default() };
                if op.kind == "fill" {
                    let rule = if t[1] == "eo" { FillRule::EvenOdd } else { FillRule::Winding };
                    frame.pixmap.fill_path(&scene.paths[&t[0]], &paint, rule, total, clip.as_deref());
                } else if let Some(rect) = Rect::from_xywh(number(&t[0]), number(&t[1]), number(&t[2]), number(&t[3])) {
                    frame.pixmap.fill_rect(rect, &paint, total, clip.as_deref());
                }
            }
            "stroke" => {
                let mut stroke = Stroke {
                    width: number(&t[1]),
                    miter_limit: number(&t[4]),
                    line_cap: match t[2].as_str() { "round" => LineCap::Round, "square" => LineCap::Square, _ => LineCap::Butt },
                    line_join: match t[3].as_str() { "round" => LineJoin::Round, "bevel" => LineJoin::Bevel, _ => LineJoin::Miter },
                    dash: None,
                };
                let mut i = 5;
                if t[i] == "-" {
                    i += 1;
                } else {
                    i += 1;
                    let count = t[i].parse::<usize>().map_err(|e| e.to_string())?;
                    i += 1;
                    let intervals: Vec<f32> = t[i..i + count].iter().map(|v| number(v)).collect();
                    i += count;
                    stroke.dash = StrokeDash::new(intervals, number(&t[i]));
                    i += 1;
                }
                let anti_alias = t[i] == "1";
                i += 1;
                let Some(shader) = make_shader(t, &mut i) else { continue };
                let paint = Paint { shader, blend_mode: blend, anti_alias, force_hq_pipeline: false, ..Paint::default() };
                frame.pixmap.stroke_path(&scene.paths[&t[0]], &paint, &stroke, total, clip.as_deref());
            }
            "image" => {
                let quality = match t[5].as_str() {
                    "nearest" => FilterQuality::Nearest,
                    "bilinear" => FilterQuality::Bilinear,
                    "bicubic" => FilterQuality::Bicubic,
                    other => return Err(format!("unsupported image filter {other}")),
                };
                let image = &scene.images[&t[0]];
                let (x, y, w, h) = (number(&t[1]), number(&t[2]), number(&t[3]), number(&t[4]));
                let local = Transform::from_row(w / image.width() as f32, 0.0, 0.0, h / image.height() as f32, x, y);
                let paint = Paint { shader: Pattern::new(image.as_ref(), SpreadMode::Pad, quality, number(&t[6]), local), blend_mode: blend, anti_alias: true, force_hq_pipeline: false, ..Paint::default() };
                if let Some(rect) = Rect::from_xywh(x, y, w, h) {
                    frame.pixmap.fill_rect(rect, &paint, total, clip.as_deref());
                }
            }
            "blur" => return Err("unsupported blur".to_string()),
            "text" => {
                let engine = text.as_mut().ok_or("text without font")?;
                let size = number(&t[1]) * frame.dpr;
                let color = [number(&t[4]) as u8, number(&t[5]) as u8, number(&t[6]) as u8, number(&t[7]) as u8];
                engine.draw(&mut frame.pixmap, index, scene.shape_every_frame, size, number(&t[2]) * frame.dpr, number(&t[3]) * frame.dpr, color, &op.text)?;
            }
            other => return Err(format!("unknown op {other}")),
        }
    }
    Ok(())
}

fn load(path: &str) -> Result<Scene, String> {
    let directory = FsPath::new(path).parent().unwrap_or(FsPath::new("."));
    let source = fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let mut scene = Scene::default();
    for line in source.lines().filter(|line| !line.is_empty()) {
        let kind = line.split(' ').next().unwrap_or("");
        if kind == "text" {
            let (head, text) = line.split_once(" | ").ok_or("text op without |")?;
            let tokens = head.split_whitespace().skip(1).map(str::to_string).collect();
            scene.ops.push(Op { kind: kind.to_string(), tokens, text: text.to_string() });
            continue;
        }
        let t: Vec<String> = line.split_whitespace().skip(1).map(str::to_string).collect();
        match kind {
            "scene" => {
                scene.width = t[0].parse().map_err(|_| "width")?;
                scene.height = t[1].parse().map_err(|_| "height")?;
                scene.shape_every_frame = t.windows(2).any(|pair| pair[0] == "textmode" && pair[1] == "shape");
            }
            "font" => scene.font = Some(fs::read(directory.join(&t[1])).map_err(|e| format!("font {}: {e}", t[1]))?),
            "img" => {
                let size = IntSize::from_wh(t[1].parse().map_err(|_| "w")?, t[2].parse().map_err(|_| "h")?).ok_or("image size")?;
                let data = fs::read(directory.join(&t[3])).map_err(|e| format!("image {}: {e}", t[3]))?;
                scene.images.insert(t[0].clone(), Pixmap::from_vec(data, size).ok_or("image data")?);
            }
            "path" => {
                let path = parse_path(&t[1..]).ok_or("path")?;
                scene.paths.insert(t[0].clone(), path);
            }
            _ => scene.ops.push(Op { kind: kind.to_string(), tokens: t, text: String::new() }),
        }
    }
    Ok(scene)
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let option = |name: &str| args.iter().position(|arg| arg == name).and_then(|at| args.get(at + 1)).cloned();
    let scene_path = option("--scene").ok_or("--scene required")?;
    let dpr: f32 = option("--dpr").and_then(|v| v.parse().ok()).unwrap_or(1.0);
    let runs: usize = option("--runs").and_then(|v| v.parse().ok()).unwrap_or(30);
    let warmup: usize = option("--warmup").and_then(|v| v.parse().ok()).unwrap_or(5);
    let baseline = max_rss_kb();

    let scene = load(&scene_path)?;
    let mut text = scene.font.as_deref().map(text::Text::new);
    let pixels = (scene.width as f32 * dpr) as u32;
    let rows = (scene.height as f32 * dpr) as u32;
    let mut frame = Frame { pixmap: Pixmap::new(pixels, rows).ok_or("pixmap")?, base: Transform::from_scale(dpr, dpr), dpr };

    let mut times = Vec::new();
    let mut cpu_times = Vec::new();
    let mut first_ms = 0.0;
    for run in 0..warmup + runs + 1 {
        let cpu_start = thread_cpu_ms();
        let start = Instant::now();
        let outcome = play(&scene, &mut frame, &mut text);
        let ms = start.elapsed().as_secs_f64() * 1e3;
        let cpu = thread_cpu_ms() - cpu_start;
        if let Err(reason) = outcome {
            println!("{{\"engine\":\"tiny-skia\",\"unsupported\":{:?}}}", reason);
            return Ok(());
        }
        if run == 0 {
            first_ms = ms;
        } else if run > warmup {
            times.push(ms);
            cpu_times.push(cpu);
        }
    }
    let peak = max_rss_kb();
    if let Some(out) = option("--out") {
        fs::write(&out, frame.pixmap.data()).map_err(|e| e.to_string())?;
    }
    let list = |values: &[f64]| values.iter().map(|v| format!("{v:.4}")).collect::<Vec<_>>().join(",");
    println!(
        "{{\"engine\":\"tiny-skia\",\"width\":{},\"height\":{},\"dpr\":{},\"first_ms\":{:.4},\"rss_kb\":{},\"rss_baseline_kb\":{},\"times_ms\":[{}],\"cpu_times_ms\":[{}]}}",
        pixels, rows, dpr, first_ms, peak, baseline, list(&times), list(&cpu_times)
    );
    Ok(())
}
