// c = a + b over 2^26 f32 (64M). Dispatch 512 x 512 workgroups of 256 threads.
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let i = gid.y * (groups.x * 256u) + gid.x;
  c[i] = a[i] + b[i];
}
