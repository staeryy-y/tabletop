// Pure camera-motion math: WASD pans, Q/E rotates — so a player can sit at their own
// side of a virtual table (see seating.ts) and turn their own view to face it, the way
// they would at a physical table, independent of how anyone else is oriented. No
// PixiJS/DOM here; table.ts just calls stepCamera() every frame with whichever keys are
// currently held and applies the result to the world container's transform.

export interface CameraState {
  x: number;
  y: number;
  /** Radians. */
  rotation: number;
}

export interface CameraInput {
  up: boolean; // W
  down: boolean; // S
  left: boolean; // A
  right: boolean; // D
  rotateCCW: boolean; // Q
  rotateCW: boolean; // E
}

export const NO_CAMERA_INPUT: CameraInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  rotateCCW: false,
  rotateCW: false,
};

function normalizeAngle(radians: number): number {
  const twoPi = 2 * Math.PI;
  return ((radians % twoPi) + twoPi) % twoPi;
}

/** Advances the camera by one frame of `dtSeconds`, given which keys are currently
 * held. Pan speed is in world units/second, rotate speed in radians/second — both
 * always positive; direction comes from which keys are set. Diagonal panning (e.g. W+D)
 * is normalized so it isn't faster than a single direction. */
export function stepCamera(
  state: CameraState,
  input: CameraInput,
  dtSeconds: number,
  panSpeed: number,
  rotateSpeed: number,
): CameraState {
  let dx = 0;
  let dy = 0;
  if (input.up) dy -= 1;
  if (input.down) dy += 1;
  if (input.left) dx -= 1;
  if (input.right) dx += 1;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude > 0) {
    dx /= magnitude;
    dy /= magnitude;
  }

  let rotationInput = 0;
  if (input.rotateCW) rotationInput += 1;
  if (input.rotateCCW) rotationInput -= 1;

  return {
    x: state.x + dx * panSpeed * dtSeconds,
    y: state.y + dy * panSpeed * dtSeconds,
    rotation: normalizeAngle(state.rotation + rotationInput * rotateSpeed * dtSeconds),
  };
}
