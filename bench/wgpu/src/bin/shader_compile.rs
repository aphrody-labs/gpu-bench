//! WGSL front-end and back-end compile time through naga, the compiler inside wgpu (no GPU needed, so it runs on any host).
//! Usage: shader-compile [--runs N] [--warmup N] <file.wgsl | directory>...   (directories are walked for *.wgsl)
//! Output: one JSON document on stdout; per shader and stage the samples in milliseconds plus the input and output sizes.
use anyhow::{Context, Result};
use naga::back::{hlsl, msl, spv, wgsl as wgsl_out};
use naga::valid::{Capabilities, ValidationFlags, Validator};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn collect(path: &Path, files: &mut Vec<PathBuf>) {
    if path.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            let mut sorted: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            sorted.sort();
            for entry in sorted {
                collect(&entry, files);
            }
        }
    } else if path.extension().is_some_and(|e| e == "wgsl") {
        files.push(path.to_path_buf());
    }
}

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn stage(name: &str, runs: usize, warmup: usize, mut work: impl FnMut() -> Result<usize>) -> (String, Value) {
    let mut samples = Vec::new();
    let mut output = 0usize;
    for round in 0..warmup + runs {
        let start = Instant::now();
        match work() {
            Ok(bytes) => output = bytes,
            Err(error) => return (name.to_string(), json!({ "error": format!("{error:#}") })),
        }
        if round >= warmup {
            samples.push(ms(start));
        }
    }
    (name.to_string(), json!({ "samples_ms": samples, "output_bytes": output }))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut runs = 20usize;
    let mut warmup = 3usize;
    let mut inputs = Vec::new();
    let mut iterator = args.iter();
    while let Some(argument) = iterator.next() {
        match argument.as_str() {
            "--runs" => runs = iterator.next().context("--runs needs a value")?.parse()?,
            "--warmup" => warmup = iterator.next().context("--warmup needs a value")?.parse()?,
            other => inputs.push(PathBuf::from(other)),
        }
    }
    let mut files = Vec::new();
    for input in &inputs {
        collect(input, &mut files);
    }
    let mut shaders = Vec::new();
    for file in files {
        let source = std::fs::read_to_string(&file).with_context(|| file.display().to_string())?;
        let mut stages = serde_json::Map::new();
        let parsed = naga::front::wgsl::parse_str(&source);
        let module = match parsed {
            Ok(module) => module,
            Err(error) => {
                shaders.push(json!({ "file": file.display().to_string(), "bytes": source.len(), "error": format!("parse: {}", error.emit_to_string(&source)) }));
                continue;
            }
        };
        let (name, value) = stage("parse", runs, warmup, || Ok(naga::front::wgsl::parse_str(&source).map(|m| m.types.len()).map_err(|e| anyhow::anyhow!(e.emit_to_string(&source)))?));
        stages.insert(name, value);
        let validate = || Validator::new(ValidationFlags::all(), Capabilities::all()).validate(&module);
        let info = match validate() {
            Ok(info) => info,
            Err(error) => {
                stages.insert("validate".into(), json!({ "error": format!("{error:?}") }));
                shaders.push(json!({ "file": file.display().to_string(), "bytes": source.len(), "stages": stages }));
                continue;
            }
        };
        let (name, value) = stage("validate", runs, warmup, || Ok(validate().map(|_| 0).map_err(|e| anyhow::anyhow!("{e:?}"))?));
        stages.insert(name, value);
        let (name, value) = stage("spirv", runs, warmup, || Ok(spv::write_vec(&module, &info, &spv::Options::default(), None).map(|w| w.len() * 4).map_err(|e| anyhow::anyhow!("{e:?}"))?));
        stages.insert(name, value);
        let (name, value) = stage("wgsl", runs, warmup, || Ok(wgsl_out::write_string(&module, &info, wgsl_out::WriterFlags::empty()).map(|s| s.len()).map_err(|e| anyhow::anyhow!("{e:?}"))?));
        stages.insert(name, value);
        let (name, value) = stage("msl", runs, warmup, || {
            let options = msl::Options { fake_missing_bindings: true, ..Default::default() };
            Ok(msl::write_string(&module, &info, &options, &msl::PipelineOptions::default()).map(|(s, _)| s.len()).map_err(|e| anyhow::anyhow!("{e:?}"))?)
        });
        stages.insert(name, value);
        let (name, value) = stage("hlsl", runs, warmup, || {
            let options = hlsl::Options { fake_missing_bindings: true, ..Default::default() };
            let pipeline = hlsl::PipelineOptions::default();
            let mut out = String::new();
            hlsl::Writer::new(&mut out, &options, &pipeline).write(&module, &info, None).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            Ok(out.len())
        });
        stages.insert(name, value);
        shaders.push(json!({ "file": file.display().to_string(), "bytes": source.len(), "entry_points": module.entry_points.len(), "stages": stages }));
    }
    let mut totals: std::collections::BTreeMap<String, (f64, usize)> = std::collections::BTreeMap::new();
    let mut failed = 0usize;
    for shader in &shaders {
        let Some(stages) = shader.get("stages").and_then(Value::as_object) else {
            failed += 1;
            continue;
        };
        for (name, value) in stages {
            if let Some(samples) = value.get("samples_ms").and_then(Value::as_array) {
                let values: Vec<f64> = samples.iter().filter_map(Value::as_f64).collect();
                let entry = totals.entry(name.clone()).or_default();
                entry.0 += values.iter().sum::<f64>() / values.len().max(1) as f64;
                entry.1 += 1;
            }
        }
    }
    let totals: serde_json::Map<String, Value> = totals.into_iter().map(|(name, (sum, count))| (name, json!({ "sum_of_mean_ms": sum, "shaders": count }))).collect();
    println!("{}", json!({ "tool": "shader-compile", "package": env!("CARGO_PKG_NAME"), "runs": runs, "warmup": warmup, "unparsed_shaders": failed, "totals": totals, "shaders": shaders }));
    Ok(())
}
