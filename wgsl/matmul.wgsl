// C = A x B, 2048 x 2048 f32, 16 x 16 shared-memory tiles. Dispatch 128 x 128 workgroups.
const N = 2048u;
const TILE = 16u;
const SEED = 0u;

@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> C: array<f32>;

var<workgroup> tile_a: array<f32, 256>;
var<workgroup> tile_b: array<f32, 256>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  var acc = 0.0;
  for (var t = 0u; t < N / TILE; t++) {
    tile_a[l.y * TILE + l.x] = A[g.y * N + t * TILE + l.x];
    tile_b[l.y * TILE + l.x] = B[(t * TILE + l.y) * N + g.x];
    workgroupBarrier();
    for (var k = 0u; k < TILE; k++) {
      acc += tile_a[l.y * TILE + k] * tile_b[k * TILE + l.x];
    }
    workgroupBarrier();
  }
  C[g.y * N + g.x] = acc + f32(SEED);
}
