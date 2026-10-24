// What an XR "select" does, and which ray the AR placement hit test follows.
// Pure functions (no three.js, no DOM) so e2e can import them directly.

/**
 * The XR input source whose target ray should drive the placement hit test:
 * a tracked controller (Quest), preferring the right hand. Phones only have
 * transient "screen" sources, so they keep the viewer (camera-centre) ray.
 */
export function hitTestPointer(inputSources) {
  const pointers = Array.from(inputSources || []).filter(
    (source) => source?.targetRayMode === "tracked-pointer" && source.targetRaySpace,
  );
  return pointers.find((source) => source.handedness === "right") || pointers[0] || null;
}

/**
 * Decide what one select does.
 * - `panelHit`: the scene panel's hit result — a button id, "" for the panel
 *   background, or null when the ray missed the panel (or it is hidden).
 * - `barHit`: whether the ray hits a district.
 * Returns "control" (press the panel button), "place", "pick", "clear" or "none".
 * In VR a select that misses both the panel and every district does nothing:
 * it never changes the day or the selection behind the user's back.
 */
export function selectAction({
  sessionKind,
  panelHit = null,
  placed = false,
  reticleVisible = false,
  barHit = false,
}) {
  const panelLive = sessionKind === "immersive-vr" || (sessionKind === "immersive-ar" && placed);
  if (panelLive && panelHit !== null) return panelHit ? "control" : "none";
  if (sessionKind === "immersive-vr") return barHit ? "pick" : "none";
  if (sessionKind !== "immersive-ar") return "none";
  if (!placed) return reticleVisible ? "place" : "none";
  return barHit ? "pick" : "clear";
}
