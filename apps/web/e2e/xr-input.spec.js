// gsc-2026 #1: XR device input. Pure functions only: xrInput.js is imported
// straight into the test runner, no page, so these run without a headset.
import { expect, test } from "@playwright/test";
import { hitTestPointer, selectAction } from "../src/surfaces/xr/xrInput.js";

const space = {};
const source = (targetRayMode, handedness = "none") => ({ targetRayMode, handedness, targetRaySpace: space });

test("phones keep the viewer ray; a headset places with a controller ray, right hand first", () => {
  // A phone screen tap is a transient "screen" source: placement stays on the camera centre.
  expect(hitTestPointer([source("screen")])).toBeNull();
  expect(hitTestPointer([])).toBeNull();
  expect(hitTestPointer(undefined)).toBeNull();
  // Gaze (head) input is not a controller either.
  expect(hitTestPointer([source("gaze")])).toBeNull();
  const left = source("tracked-pointer", "left");
  const right = source("tracked-pointer", "right");
  expect(hitTestPointer([left, right])).toBe(right);
  expect(hitTestPointer([left])).toBe(left);
  // A source without a target-ray space cannot drive a hit test.
  expect(hitTestPointer([{ targetRayMode: "tracked-pointer", handedness: "right" }])).toBeNull();
});

test("in VR a select that misses the panel and every district does nothing", () => {
  const vr = { sessionKind: "immersive-vr" };
  // The regression: a stray trigger pull used to advance the forecast day.
  expect(selectAction({ ...vr, panelHit: null, barHit: false })).toBe("none");
  expect(selectAction({ ...vr, panelHit: "", barHit: true })).toBe("none"); // panel background
  expect(selectAction({ ...vr, panelHit: "rain:80" })).toBe("control");
  expect(selectAction({ ...vr, panelHit: null, barHit: true })).toBe("pick");
});

test("in AR a select places first, then picks or clears a district", () => {
  const ar = { sessionKind: "immersive-ar" };
  expect(selectAction({ ...ar, placed: false, reticleVisible: true })).toBe("place");
  expect(selectAction({ ...ar, placed: false, reticleVisible: false })).toBe("none");
  // The in-scene panel only answers once the city is on the table.
  expect(selectAction({ ...ar, placed: false, reticleVisible: true, panelHit: "rain:40" })).toBe("place");
  expect(selectAction({ ...ar, placed: true, panelHit: "day-next" })).toBe("control");
  expect(selectAction({ ...ar, placed: true, barHit: true })).toBe("pick");
  expect(selectAction({ ...ar, placed: true, barHit: false })).toBe("clear");
  // Outside a session an XR select has no meaning.
  expect(selectAction({ sessionKind: null, barHit: true })).toBe("none");
});
