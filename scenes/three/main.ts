// three.js side of the three.js vs Bevy scene bench: WebGPURenderer only (no WebGL). Spec in docs/scene.md, mirrored in scenes/bevy/src/main.rs.
// Query string: n (cubes), frames, warmup, gpu (1 = track GPU timestamps; changes timing, so it is a separate run kind).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const query = new URLSearchParams(location.search);
const number = (name: string, fallback: number) => Number(query.get(name) ?? fallback);
const n = number("n", 1000);
const frames = number("frames", 600);
const warmup = number("warmup", 60);
const seconds = number("seconds", 20);
const trackGpu = query.get("gpu") === "1";
const SPACING = 2.2;
const LAYERS = 4;

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: trackGpu, forceWebGL: false });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(1920, 1080);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.NoToneMapping;
  document.body.append(renderer.domElement);
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "WebGPU" : "other";

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.1, 0.1, 0.1);
  const side = Math.ceil(Math.sqrt(n / LAYERS));
  const extent = side * SPACING;

  const cubes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.5, roughness: 0.5 }), n);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const x = i % side;
    const z = Math.floor(i / side) % side;
    const y = Math.floor(i / (side * side));
    matrix.setPosition((x - side / 2) * SPACING, y * SPACING, (z - side / 2) * SPACING);
    cubes.setMatrixAt(i, matrix);
  }
  cubes.castShadow = true;
  cubes.receiveShadow = true;
  scene.add(cubes);

  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(0.4, 0.8, 0.5).multiplyScalar(extent);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  const reach = extent * 0.8;
  Object.assign(light.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.1, far: extent * 3 });
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 1));

  const camera = new THREE.PerspectiveCamera(50, 1920 / 1080, 0.1, 2000);
  camera.position.set(0, 0.45 * extent + 12, 0.75 * extent + 20);
  camera.lookAt(0, 3, 0);

  let helmetReady = false;
  let helmetFrame = -1;
  const helmetPromise = new GLTFLoader().loadAsync("/assets/DamagedHelmet.gltf").then((gltf) => {
    gltf.scene.position.set(0, LAYERS * SPACING + 1.5, 0);
    gltf.scene.rotation.x = Math.PI / 2;
    gltf.scene.traverse((object) => ((object as THREE.Mesh).isMesh && ((object.castShadow = true), (object.receiveShadow = true))));
    scene.add(gltf.scene);
    helmetReady = true;
  });

  const frameMs: number[] = [];
  const cpuMs: number[] = [];
  const gpuMs: number[] = [];
  let firstFrameMs: number | undefined;
  let helmetMs: number | undefined;
  let frame = 0;
  let last = performance.now();
  let measureStart = 0;

  await new Promise<void>((resolve) => {
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      if (frame === warmup + 1) measureStart = now;
      if (frame > warmup) frameMs.push(now - last);
      last = now;
      if (helmetReady && helmetFrame < 0) helmetFrame = frame;
      renderer.render(scene, camera);
      const cpu = performance.now() - now;
      if (frame > warmup) cpuMs.push(cpu);
      if (trackGpu && frame > warmup) void renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then((value: number) => gpuMs.push(value));
      frame++;
      if (frame === 2 && firstFrameMs === undefined) firstFrameMs = performance.now();
      if (helmetFrame >= 0 && frame === helmetFrame + 2 && helmetMs === undefined) helmetMs = performance.now();
      if (frameMs.length >= frames || (frameMs.length >= 30 && now - measureStart > seconds * 1000)) {
        renderer.setAnimationLoop(null);
        resolve();
      }
    });
  });
  await helmetPromise;
  if (trackGpu) await new Promise((resolve) => setTimeout(resolve, 500));

  const info = renderer.info as unknown as { render: { drawCalls: number; triangles: number } };
  await fetch("/result", {
    method: "POST",
    body: JSON.stringify({
      labels: { host: "chrome", engine: "three", backend, three: THREE.REVISION, userAgent: navigator.userAgent, devicePixelRatio: String(devicePixelRatio) },
      config: { n, frames, warmup, seconds, gpu: trackGpu, canvas: [renderer.domElement.width, renderer.domElement.height] },
      firstFrameMs,
      helmetMs,
      frameMs,
      cpuMs,
      gpuMs,
      drawCalls: info.render.drawCalls,
      triangles: info.render.triangles,
    }),
  });
}

main().catch((error) => fetch("/result", { method: "POST", body: JSON.stringify({ failed: String(error?.stack ?? error) }) }));
