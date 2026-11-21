// Pass 2 of the sum reduction: 32768 partial sums -> 1 value. A single workgroup of 256 threads, 128 elements each.
@group(0) @binding(0) var<storage, read> partials: array<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<f32>;

var<workgroup> scratch: array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) l: vec3<u32>) {
  var sum = 0.0;
  for (var k = 0u; k < 128u; k++) {
    sum += partials[l.x + k * 256u];
  }
  scratch[l.x] = sum;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride >>= 1u) {
    if (l.x < stride) {
      scratch[l.x] += scratch[l.x + stride];
    }
    workgroupBarrier();
  }
  if (l.x == 0u) {
    result[0] = scratch[0];
  }
}
