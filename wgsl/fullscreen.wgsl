// Fragment-bound fullscreen pass: 1024 dependent sin/cos iterations per pixel, no early exit.
const SEED = 0u;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var a = pos.x * 0.001 + f32(SEED);
  var b = pos.y * 0.001;
  for (var k = 0u; k < 1024u; k++) {
    a = sin(b * 1.7 + a) * 0.999 + 0.001 * b;
    b = cos(a * 1.3 - b) * 0.999;
  }
  return vec4f(abs(a), abs(b), abs(a * b), 1.0);
}
