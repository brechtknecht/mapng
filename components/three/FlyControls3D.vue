<script setup>
import { ref, watch, onUnmounted } from 'vue';
import * as THREE from 'three';
import { useTresContext, useRenderLoop } from '@tresjs/core';

// Ego-shooter fly camera for the 3D preview: pointer-lock mouse look +
// WASD/E/Q movement, speed on the wheel, Shift to boost. Mounted INSTEAD of
// OrbitControls while fly mode is active (Preview3D swaps them).
//
// The component owns the camera pose; on demand (R key, or the HUD button
// via the exposed getPose()) it reports the current pose so Preview3D can
// turn it into a bake-refinement station — "what you see is what gets
// refined".

const props = defineProps({
  // Live FOV from the HUD slider — applied to the active camera.
  fov: { type: Number, default: 70 },
});
const emit = defineEmits(['refine', 'locked-change']);

const { camera, renderer } = useTresContext();

const keys = new Set();
const locked = ref(false);
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const moveDir = new THREE.Vector3();
// Scene units are metrically uniform (X/Z native, Y pre-scaled by
// unitsPerMeter), so speed is plain scene-units/second. The terrain spans
// 100 units; 8 u/s crosses it in ~12 s and the wheel scales 0.4–80 u/s.
const speed = ref(8);
const MIN_SPEED = 0.4;
const MAX_SPEED = 80;

let savedFov = null;

const dom = () => renderer.value?.domElement ?? null;

const getPose = () => {
  const cam = camera.value;
  if (!cam) return null;
  const position = cam.getWorldPosition(new THREE.Vector3());
  const direction = cam.getWorldDirection(new THREE.Vector3());
  return {
    position: position.toArray(),
    direction: direction.toArray(),
    fov: cam.fov,
    // The refine frustum must match the REAL view: fov is vertical only,
    // aspect carries the horizontal extent of what the user sees.
    aspect: cam.aspect ?? 1,
  };
};
defineExpose({ getPose });

const onClick = () => {
  if (!locked.value) dom()?.requestPointerLock();
};
const onLockChange = () => {
  locked.value = document.pointerLockElement === dom();
  emit('locked-change', locked.value);
  if (!locked.value) keys.clear();
};
const onMouseMove = (e) => {
  if (!locked.value || !camera.value) return;
  euler.setFromQuaternion(camera.value.quaternion);
  euler.y -= e.movementX * 0.0022;
  euler.x -= e.movementY * 0.0022;
  euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, euler.x));
  camera.value.quaternion.setFromEuler(euler);
};
const onKeyDown = (e) => {
  if (!locked.value) return;
  if (e.code === 'KeyR') {
    const pose = getPose();
    if (pose) emit('refine', pose);
    return;
  }
  keys.add(e.code);
};
const onKeyUp = (e) => keys.delete(e.code);
const onWheel = (e) => {
  if (!locked.value) return;
  e.preventDefault();
  speed.value = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed.value * (e.deltaY < 0 ? 1.25 : 0.8)));
};

const attach = () => {
  const el = dom();
  if (!el) return;
  el.addEventListener('click', onClick);
  el.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  if (camera.value) {
    savedFov = camera.value.fov;
    camera.value.fov = props.fov;
    camera.value.updateProjectionMatrix();
  }
};
const detach = () => {
  const el = dom();
  el?.removeEventListener('click', onClick);
  el?.removeEventListener('wheel', onWheel);
  document.removeEventListener('pointerlockchange', onLockChange);
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
  if (document.pointerLockElement === el) document.exitPointerLock();
  if (camera.value && savedFov !== null) {
    camera.value.fov = savedFov;
    camera.value.updateProjectionMatrix();
  }
  keys.clear();
  locked.value = false;
};

// The renderer (and its canvas) may not exist yet at setup — attach as soon
// as it appears.
watch(() => renderer.value, (r, _old, onCleanup) => {
  if (!r) return;
  attach();
  onCleanup(detach);
}, { immediate: true });
onUnmounted(detach);

watch(() => props.fov, (fov) => {
  if (camera.value) {
    camera.value.fov = fov;
    camera.value.updateProjectionMatrix();
  }
});

// --- gamepad (standard mapping) ---------------------------------------------
// Left stick: move · right stick: look · RT/LT: up/down · RB: boost ·
// A: refine this view. Needs NO pointer lock — plug in and fly.
let prevButtonA = false;
const deadzone = (v) => (Math.abs(v) < 0.15 ? 0 : v);
const pollGamepad = (delta) => {
  const cam = camera.value;
  if (!cam || typeof navigator.getGamepads !== 'function') return;
  const gp = [...navigator.getGamepads()].find((p) => p?.connected);
  if (!gp) return;

  const lx = deadzone(gp.axes[0] ?? 0);
  const ly = deadzone(gp.axes[1] ?? 0);
  const rx = deadzone(gp.axes[2] ?? 0);
  const ry = deadzone(gp.axes[3] ?? 0);
  const upDown = (gp.buttons[7]?.value ?? 0) - (gp.buttons[6]?.value ?? 0); // RT − LT

  if (rx || ry) {
    euler.setFromQuaternion(cam.quaternion);
    euler.y -= rx * 2.2 * delta;
    euler.x -= ry * 1.8 * delta;
    euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, euler.x));
    cam.quaternion.setFromEuler(euler);
  }
  if (lx || ly || upDown) {
    moveDir.set(lx, 0, ly).applyQuaternion(cam.quaternion);
    moveDir.y += upDown; // world-space vertical
    const boost = gp.buttons[5]?.pressed ? 4 : 1;
    cam.position.addScaledVector(moveDir, speed.value * boost * Math.min(delta, 0.1));
  }

  const buttonA = gp.buttons[0]?.pressed ?? false;
  if (buttonA && !prevButtonA) {
    const pose = getPose();
    if (pose) emit('refine', pose);
  }
  prevButtonA = buttonA;
};

const { onLoop } = useRenderLoop();
onLoop(({ delta }) => {
  pollGamepad(delta);
  const cam = camera.value;
  if (!cam || !locked.value || keys.size === 0) return;
  moveDir.set(0, 0, 0);
  if (keys.has('KeyW')) moveDir.z -= 1;
  if (keys.has('KeyS')) moveDir.z += 1;
  if (keys.has('KeyA')) moveDir.x -= 1;
  if (keys.has('KeyD')) moveDir.x += 1;
  if (keys.has('KeyE') || keys.has('Space')) moveDir.y += 1;
  if (keys.has('KeyQ')) moveDir.y -= 1;
  if (moveDir.lengthSq() === 0) return;
  moveDir.normalize().applyQuaternion(cam.quaternion);
  const boost = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 4 : 1;
  cam.position.addScaledVector(moveDir, speed.value * boost * Math.min(delta, 0.1));
});
</script>

<template>
  <!-- renderless: this component only drives the active camera -->
  <TresGroup />
</template>
