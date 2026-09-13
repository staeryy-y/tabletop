import { describe, expect, it } from "vitest";
import { CameraState, NO_CAMERA_INPUT, stepCamera } from "./camera";

const ORIGIN: CameraState = { x: 0, y: 0, rotation: 0 };

describe("stepCamera — panning", () => {
  it("no keys held: the camera doesn't move", () => {
    const next = stepCamera(ORIGIN, NO_CAMERA_INPUT, 1, 100, 1);
    expect(next).toEqual(ORIGIN);
  });

  it("W (up) moves in -y", () => {
    const next = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, up: true }, 1, 100, 1);
    expect(next.x).toBeCloseTo(0);
    expect(next.y).toBeCloseTo(-100);
  });

  it("S (down) moves in +y", () => {
    const next = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, down: true }, 1, 100, 1);
    expect(next.y).toBeCloseTo(100);
  });

  it("A (left) moves in -x, D (right) moves in +x", () => {
    expect(stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, left: true }, 1, 100, 1).x).toBeCloseTo(-100);
    expect(stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, right: true }, 1, 100, 1).x).toBeCloseTo(100);
  });

  it("opposite keys held together cancel out", () => {
    const next = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, left: true, right: true, up: true, down: true }, 1, 100, 1);
    expect(next.x).toBeCloseTo(0);
    expect(next.y).toBeCloseTo(0);
  });

  it("diagonal movement (e.g. W+D) is normalized to the same speed as a single direction", () => {
    const next = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, up: true, right: true }, 1, 100, 1);
    const distance = Math.hypot(next.x, next.y);
    expect(distance).toBeCloseTo(100);
  });

  it("pan distance scales linearly with dt and with speed", () => {
    const half = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, up: true }, 0.5, 100, 1);
    expect(half.y).toBeCloseTo(-50);
    const doubleSpeed = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, up: true }, 1, 200, 1);
    expect(doubleSpeed.y).toBeCloseTo(-200);
  });

  it("panning does not touch rotation", () => {
    const start: CameraState = { x: 0, y: 0, rotation: 1.5 };
    const next = stepCamera(start, { ...NO_CAMERA_INPUT, up: true }, 1, 100, 1);
    expect(next.rotation).toBeCloseTo(1.5);
  });
});

describe("stepCamera — rotation", () => {
  it("E (rotateCW) increases rotation", () => {
    const next = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, rotateCW: true }, 1, 100, 2);
    expect(next.rotation).toBeCloseTo(2);
  });

  it("Q (rotateCCW) decreases rotation, wrapping into [0, 2π)", () => {
    const next = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, rotateCCW: true }, 1, 100, 2);
    expect(next.rotation).toBeCloseTo(2 * Math.PI - 2);
  });

  it("Q and E held together cancel out", () => {
    const next = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, rotateCW: true, rotateCCW: true }, 1, 100, 2);
    expect(next.rotation).toBeCloseTo(0);
  });

  it("rotation wraps past a full turn", () => {
    const start: CameraState = { x: 0, y: 0, rotation: 2 * Math.PI - 0.1 };
    const next = stepCamera(start, { ...NO_CAMERA_INPUT, rotateCW: true }, 1, 0, 0.5);
    expect(next.rotation).toBeCloseTo(0.4);
  });

  it("rotating does not touch position", () => {
    const start: CameraState = { x: 5, y: -5, rotation: 0 };
    const next = stepCamera(start, { ...NO_CAMERA_INPUT, rotateCW: true }, 1, 100, 1);
    expect(next.x).toBeCloseTo(5);
    expect(next.y).toBeCloseTo(-5);
  });

  it("panning and rotating simultaneously both apply", () => {
    const next = stepCamera(ORIGIN, { ...NO_CAMERA_INPUT, up: true, rotateCW: true }, 1, 100, 1);
    expect(next.y).toBeCloseTo(-100);
    expect(next.rotation).toBeCloseTo(1);
  });
});
