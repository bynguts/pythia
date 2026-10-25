// gsc-2026 #1: XR device input. Pure functions only: xrInput.js is imported
// straight into the test runner, no page, so these run without a headset.
import { expect, test } from "@playwright/test";
import { hitTestPointer, selectAction, twoFingerChange } from "../src/surfaces/xr/xrInput.js";
import { askToScenario, traceKeys } from "../src/surfaces/xr/xrAsk.js";

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

// gsc-2026 #12: two-finger pinch and twist on the AR overlay.
test("a pinch scales by the finger spread and a twist turns the model with the fingers", () => {
  const prev = [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
  ];
  const spread = twoFingerChange(prev, [
    { x: 50, y: 100 },
    { x: 250, y: 100 },
  ]);
  expect(spread.scale).toBeCloseTo(2);
  expect(spread.rotateDeg).toBeCloseTo(0);
  // A clockwise twist on screen (y points down) turns the model clockwise seen from above.
  const twist = twoFingerChange(prev, [
    { x: 100, y: 100 },
    { x: 100 + 100 * Math.cos(Math.PI / 6), y: 100 + 100 * Math.sin(Math.PI / 6) },
  ]);
  expect(twist.scale).toBeCloseTo(1);
  expect(twist.rotateDeg).toBeCloseTo(-30);
  // Crossing the ±180° seam stays a small turn.
  const seam = twoFingerChange(
    [
      { x: 0, y: 0 },
      { x: -100, y: -1 },
    ],
    [
      { x: 0, y: 0 },
      { x: -100, y: 1 },
    ],
  );
  expect(Math.abs(seam.rotateDeg)).toBeLessThan(2);
  // Two fingers on one spot give no step.
  expect(twoFingerChange([prev[0], prev[0]], prev)).toBeNull();
});

// gsc-2026 #7: Ask Pythia's scenario becomes the table's shared scenario.
test("an ask's run_scenario result maps onto the table presets and its trace", () => {
  const result = {
    city: "jakarta",
    scenario: { rainfall_mm: 80, event_attendance: 50000, venue_id: "jis", day: 1 },
    trace: [
      { step: "parse_scenario", class: "LOCAL_PARSER" },
      { step: "run_scenario" },
      { step: "forecast_model" },
      { step: "resource_rule" },
      { step: "queue_simulation" },
    ],
  };
  expect(askToScenario(result, "jakarta")).toEqual({ rain: 80, eventPreset: "50k", venueId: "jis", day: 1 });
  // No crowd: no venue, whatever the parser defaulted to.
  expect(
    askToScenario({ ...result, scenario: { ...result.scenario, event_attendance: 0 } }, "jakarta"),
  ).toMatchObject({
    eventPreset: "none",
    venueId: null,
  });
  expect(
    askToScenario({ ...result, scenario: { ...result.scenario, event_attendance: 90000 } }, "jakarta"),
  ).toMatchObject({ eventPreset: "100k" });
  // A question about the other city never rewrites this table.
  expect(askToScenario({ ...result, city: "hcmc", links: { xr: "/xr?city=hcmc" } }, "jakarta")).toEqual({
    otherCity: "hcmc",
    link: "/xr?city=hcmc",
  });
  expect(askToScenario(null, "jakarta")).toBeNull();
  expect(traceKeys(result.trace)).toEqual([
    "xr3_trace_local",
    "xr3_trace_forecast",
    "xr3_trace_resources",
    "xr3_trace_queue",
  ]);
  expect(traceKeys([{ step: "parse_scenario", class: "LLM" }])).toEqual(["xr3_trace_llm"]);
});
