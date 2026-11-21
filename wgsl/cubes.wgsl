// 100k instanced cubes (36 vertices each, pulled from constants), depth tested, no culling.
// Instance i is a vec4f (x, y, z, scale) in a storage buffer. The camera is the constant VP (scripts/camera.ts).
const SEED = 0u;

const VP = mat4x4f(
  vec4f(1.20628514, 0.00000000, 0.00000000, 0.00000000),
  vec4f(0.00000000, 2.13864760, 0.0738753793, 0.0738716855),
  vec4f(0.00000000, 0.158418341, -0.997317620, -0.997267754),
  vec4f(-180.942771, -323.173415, 409.908350, 409.987855)
);

const FACE_N = array<vec3f, 6>(vec3f(1, 0, 0), vec3f(-1, 0, 0), vec3f(0, 1, 0), vec3f(0, -1, 0), vec3f(0, 0, 1), vec3f(0, 0, -1));
const FACE_U = array<vec3f, 6>(vec3f(0, 1, 0), vec3f(0, -1, 0), vec3f(0, 0, 1), vec3f(0, 0, -1), vec3f(1, 0, 0), vec3f(-1, 0, 0));
const CORNER = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));

@group(0) @binding(0) var<storage, read> instances: array<vec4f>;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  let face = vi / 6u;
  let corner = CORNER[vi % 6u];
  let n = FACE_N[face];
  let u = FACE_U[face];
  let v = cross(n, u);
  let local = n + corner.x * u + corner.y * v;
  let inst = instances[ii];
  let world = inst.xyz + local * 0.5 * inst.w;
  var out: VsOut;
  out.position = VP * vec4f(world, 1.0);
  out.normal = n;
  let h = (ii * 2654435761u) ^ SEED;
  out.color = vec3f(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u)) / 255.0;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let light = normalize(vec3f(0.4, 0.8, 0.6));
  let lambert = max(dot(in.normal, light), 0.0) * 0.8 + 0.2;
  return vec4f(in.color * lambert, 1.0);
}
