// A[i][j] = (i + 2j) % 5, B[i][j] = (3i + j) % 7 for 2048 x 2048. Dispatch 128 x 128 workgroups of 16 x 16.
@group(0) @binding(0) var<storage, read_write> A: array<f32>;
@group(0) @binding(1) var<storage, read_write> B: array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.y;
  let j = g.x;
  A[i * 2048u + j] = f32((i + 2u * j) % 5u);
  B[i * 2048u + j] = f32((3u * i + j) % 7u);
}
