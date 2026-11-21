// Pass 1 of the sum reduction: 2^26 f32 -> 32768 partial sums. Each workgroup of 256 threads reads 2048 elements.
@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> partials: array<f32>;

var<workgroup> scratch: array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let base = wg.x * 2048u + l.x;
  var sum = 0.0;
  for (var k = 0u; k < 8u; k++) {
    sum += input[base + k * 256u];
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
    partials[wg.x] = scratch[0];
  }
}
