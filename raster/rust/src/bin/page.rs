// Obscura page-render path: parse, style+layout, paint (tiny-skia + cosmic-text), PNG encode; per-phase timings as JSON.
use std::fs;
use std::time::Instant;

use obscura_dom::tree_sink::parse_html;
use obscura_render::{paint_prepared, prepare_dom, RenderResourceCache};

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

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let option = |name: &str| args.iter().position(|arg| arg == name).and_then(|at| args.get(at + 1)).cloned();
    let html_path = option("--html").ok_or("--html required")?;
    let (width, height) = option("--viewport")
        .and_then(|v| v.split_once('x').map(|(w, h)| (w.parse().unwrap_or(1920.0), h.parse().unwrap_or(1080.0))))
        .unwrap_or((1920.0f32, 1080.0f32));
    let runs: usize = option("--runs").and_then(|v| v.parse().ok()).unwrap_or(20);
    let warmup: usize = option("--warmup").and_then(|v| v.parse().ok()).unwrap_or(3);
    let html = fs::read_to_string(&html_path).map_err(|e| format!("{html_path}: {e}"))?;
    let baseline = max_rss_kb();

    let (mut parse, mut prepare, mut paint, mut encode) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut first = [0.0f64; 4];
    let mut last_png = Vec::new();
    for run in 0..warmup + runs + 1 {
        let started = Instant::now();
        let tree = parse_html(&html);
        let t_parse = started.elapsed().as_secs_f64() * 1e3;
        let mut resources = RenderResourceCache::default();
        let started = Instant::now();
        let mut prepared = prepare_dom(&tree, (width, height), None, &mut resources).ok_or("prepare_dom returned None")?;
        let t_prepare = started.elapsed().as_secs_f64() * 1e3;
        let started = Instant::now();
        let pixmap = paint_prepared(&tree, &mut prepared, &mut resources, (0.0, 0.0)).ok_or("paint_prepared returned None")?;
        let t_paint = started.elapsed().as_secs_f64() * 1e3;
        let started = Instant::now();
        last_png = pixmap.encode_png().map_err(|e| e.to_string())?;
        let t_encode = started.elapsed().as_secs_f64() * 1e3;
        if run == 0 {
            first = [t_parse, t_prepare, t_paint, t_encode];
        } else if run > warmup {
            parse.push(t_parse);
            prepare.push(t_prepare);
            paint.push(t_paint);
            encode.push(t_encode);
        }
    }
    let peak = max_rss_kb();
    if let Some(out) = option("--out") {
        fs::write(&out, &last_png).map_err(|e| e.to_string())?;
    }
    let list = |values: &[f64]| values.iter().map(|v| format!("{v:.4}")).collect::<Vec<_>>().join(",");
    println!(
        "{{\"engine\":\"obscura\",\"width\":{},\"height\":{},\"html_bytes\":{},\"png_bytes\":{},\"first_ms\":[{}],\"rss_kb\":{},\"rss_baseline_kb\":{},\"parse_ms\":[{}],\"prepare_ms\":[{}],\"paint_ms\":[{}],\"encode_ms\":[{}]}}",
        width, height, html.len(), last_png.len(), first.map(|v| format!("{v:.4}")).join(","), peak, baseline, list(&parse), list(&prepare), list(&paint), list(&encode)
    );
    Ok(())
}
