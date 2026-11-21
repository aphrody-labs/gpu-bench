// a[i] = i & 1023, b[i] = 1.0 over 2^26 elements (dispatch 512 x 512 workgroups of 256).
@group(0) @binding(0) var<storage, read_write> a: array<f32>;
@group(0) @binding(1) var<storage, read_write> b: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let i = gid.y * (groups.x * 256u) + gid.x;
  a[i] = f32(i & 1023u);
  b[i] = 1.0;
}
