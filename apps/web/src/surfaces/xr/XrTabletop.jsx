// /xr — the city twin as a tabletop model.
//
// Login-free. Rain / event / day presets re-fetch the scene in place, and a
// short session code lets several devices share one scenario and record an
// in-room agreement (never an official approval). The mode follows the
// device's capability:
//   immersive-ar (hit-test + dom-overlay) → "Place city on table"
//   immersive-vr                          → "Enter VR" (model floats in front)
//   neither                               → inline orbit viewer
// Every mode shows the scene's provenance: Jakarta is MODEL OUTPUT, Ho Chi
// Minh City a SIMULATED DEMO CITY — never live measurements.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Gauge,
  Glasses,
  Info,
  LogOut,
  Mic,
  MicOff,
  Minus,
  Move,
  Plus,
  RotateCcw,
  RotateCw,
  Send,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { useSpeechInput } from "../../features/assistant/useSpeechInput.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import {
  JAKARTA_PLATE,
  RISK_COLORS,
  RISK_LEVELS,
  TRUCKS_PER_DOT,
  buildCityModel,
  dayRisk,
  dayTons,
} from "./buildCityModel.js";
import { PANEL_HEIGHT_M, createScenePanel } from "./scenePanel.js";
import { hitTestPointer, selectAction, twoFingerChange } from "./xrInput.js";
import { askToScenario, traceKeys } from "./xrAsk.js";
import { LITE_RENDER, detectLite, storeLite } from "./xrLite.js";
import {
  TWIN_EVENT_PRESETS,
  TWIN_SCENARIOS,
  TWIN_VENUES,
  WEIGHBRIDGE_LANES,
  dailyRisk,
  twinHref,
  twinScenario,
  carriedRainMm,
  rainHeldText,
  rainResponseText,
  twinVenues,
} from "../../features/twin/twinLinks.js";
import { IMAGERY_CREDIT } from "../../features/twin/cityBase3d.js";
import "./xr.css";

const BACKGROUND = "#e9eeeb";
const VR_ANCHOR = new THREE.Vector3(0, 1.0, -0.7);
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// Scenario presets the tabletop can switch between in a session.
const RAIN_PRESETS = [0, 40, 80, 120];
// Event presets and venues are the twin workspace's (one source in twinLinks.js).
const EVENT_PRESETS = TWIN_EVENT_PRESETS;
// A linked venue matches a known one within ~100 m.
const VENUE_MATCH_DEG = 0.001;
const SESSION_CODE = /^[A-Z0-9]{4,8}$/;
// Satellite plates per city (only Jakarta has one; the demo city keeps the plain plate).
const CITY_PLATES = { jakarta: JAKARTA_PLATE };
// No 0/O or 1/I, so a code read aloud across the table is unambiguous.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const POLL_MS = 1500;
// Scenario edits settle before the scene is re-fetched (as in useTwinScene).
const SCENE_DEBOUNCE_MS = 450;

function finiteParam(params, key) {
  const raw = params.get(key);
  const value = raw === null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const city = params.get("city") === "hcmc" ? "hcmc" : "jakarta";
  // Optional scenario passthrough (e.g. ?rainfall_mm=42, as the twin's
  // "Open in AR/XR" link sends it). Out-of-range values are ignored.
  const rain = finiteParam(params, "rainfall_mm");
  const attendance = finiteParam(params, "event_attendance") || 0;
  const lat = finiteParam(params, "event_lat");
  const lng = finiteParam(params, "event_lng");
  const linkedVenue = lat !== null && lng !== null ? { name: null, lat, lng } : null;
  const session = (params.get("session") || "").toUpperCase();
  // The day a linked what-if applies to (the twin's `day`, or `scenario_day`).
  const linkedDay = finiteParam(params, "scenario_day") ?? finiteParam(params, "day");
  // A decision-room briefing scenario (twinLinks TWIN_SCENARIOS) sets rain, crowd and venue on today.
  const briefing = city === "jakarta" ? twinScenario(params.get("scenario")) : null;
  if (briefing)
    return {
      city,
      lang: params.get("lang"),
      rain: briefing.rain,
      eventPreset: briefing.event,
      venue: TWIN_VENUES[city].find((v) => v.id === briefing.venue) || TWIN_VENUES[city][0],
      session: SESSION_CODE.test(session) ? session : null,
      day: 0,
      scenarioId: briefing.id,
    };
  return {
    city,
    lang: params.get("lang"),
    rain: rain !== null && rain >= 0 && rain <= 300 ? rain : 0,
    // The twin only links the preset sizes; anything else snaps to the nearest.
    eventPreset: attendance <= 0 ? "none" : attendance > 75000 ? "100k" : "50k",
    venue: linkedVenue || TWIN_VENUES[city][0],
    session: SESSION_CODE.test(session) ? session : null,
    day: Number.isInteger(linkedDay) && linkedDay >= 0 && linkedDay <= 6 ? linkedDay : 0,
    scenarioId: null,
  };
}

function sceneQuery(city, scenario, venue) {
  const query = new URLSearchParams({ city, days: "7" });
  if (scenario.rain > 0) query.set("rainfall_mm", String(scenario.rain));
  // gsc M5: no `day` here. Stepping through the horizon stays local (the scene
  // already holds every day); the queue metric names the day it describes.
  const preset = EVENT_PRESETS.find((p) => p.id === scenario.eventPreset) || EVENT_PRESETS[0];
  if (preset.attendance > 0) {
    query.set("event_attendance", String(preset.attendance));
    query.set("event_lat", String(venue.lat));
    query.set("event_lng", String(venue.lng));
  }
  // gsc-2026 #5: a what-if overrides only its own day; the queue metric describes
  // that day too. Without a what-if the scene is the base week (no day sent).
  if ((scenario.rain > 0 || preset.attendance > 0) && scenario.scenarioDay > 0) {
    query.set("day", String(scenario.scenarioDay));
    query.set("scenario_day", String(scenario.scenarioDay));
  }
  return query.toString();
}

function makeSessionCode(length = 6) {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// In-headset provenance: a flat label above the model, drawn to a canvas so the
// city and its data class stay readable without the DOM overlay.
function makeLabelSprite(lines) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 200;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(19, 33, 29, 0.92)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 28);
  else ctx.rect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx.fill();
  ctx.strokeStyle = "#2fb36a";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 64px 'Inter Tight', Inter, system-ui, sans-serif";
  ctx.fillText(lines[0] || "", canvas.width / 2, lines[1] ? 72 : canvas.height / 2, canvas.width - 64);
  if (lines[1]) {
    ctx.fillStyle = "#cfe0d8";
    ctx.font = "500 40px 'Inter Tight', Inter, system-ui, sans-serif";
    ctx.fillText(lines[1], canvas.width / 2, 146, canvas.width - 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  const width = 0.5;
  sprite.scale.set(width, (width * canvas.height) / canvas.width, 1);
  sprite.name = "provenance-label";
  sprite.userData.text = lines.filter(Boolean).join(" | ");
  return {
    sprite,
    dispose: () => {
      texture.dispose();
      material.dispose();
    },
  };
}

// Owns the WebGL renderer, the orbit controls and any XR session. React only
// talks to it through the returned handle.
function createEngine({
  container,
  cityScene,
  dayIndex,
  plate,
  onSelectDistrict,
  onArStage,
  onSessionChange,
  onControl,
  lite = false,
}) {
  const reducedMotion = prefersReducedMotion();
  // Lite mode (budget phones): no antialias or shadows, 1× pixels, a smaller
  // XR framebuffer and a 30 fps orbit viewer.
  const renderer = new THREE.WebGLRenderer({ antialias: !lite, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lite ? LITE_RENDER.pixelRatio : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = !lite;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.xr.enabled = true;
  if (lite) renderer.xr.setFramebufferScaleFactor(LITE_RENDER.xrFramebufferScale);
  renderer.domElement.className = "xr-canvas-el";
  renderer.domElement.setAttribute("data-testid", "xr-canvas");
  container.appendChild(renderer.domElement);

  const scene3 = new THREE.Scene();
  const background = new THREE.Color(BACKGROUND);
  scene3.background = background;

  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);

  scene3.add(new THREE.HemisphereLight(0xffffff, 0x41524b, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(0.45, 1.1, 0.35);
  sun.castShadow = !lite;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -0.5, right: 0.5, top: 0.5, bottom: -0.5, near: 0.1, far: 3 });
  sun.shadow.bias = -0.0004;
  scene3.add(sun);

  const model = buildCityModel(cityScene, {
    dayIndex,
    reducedMotion,
    lite,
    // Lite mode drapes a 512 px copy of the satellite plate (≈40 KB, not ≈340 KB).
    plate: plate && lite ? { ...plate, url: LITE_RENDER.plateUrl } : plate,
  });
  // `anchor` is what XR places, rotates and scales; the model stays untouched.
  const anchor = new THREE.Group();
  anchor.add(model.root);
  scene3.add(anchor);
  sun.target = anchor;

  // Soft contact shadow so the model sits on something in the orbit viewer.
  const floorGeometry = new THREE.PlaneGeometry(4, 4);
  const floorMaterial = new THREE.ShadowMaterial({ opacity: 0.16 });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.0125;
  floor.receiveShadow = true;
  scene3.add(floor);

  // AR placement reticle.
  const reticleGeometry = new THREE.RingGeometry(0.06, 0.075, 48).rotateX(-Math.PI / 2);
  const reticleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const reticle = new THREE.Mesh(reticleGeometry, reticleMaterial);
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene3.add(reticle);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.035, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.3;
  controls.maxDistance = 4;
  controls.maxPolarAngle = Math.PI * 0.44;
  controls.autoRotate = !reducedMotion;
  controls.autoRotateSpeed = 0.55;
  controls.addEventListener("start", () => {
    controls.autoRotate = false;
  });

  // Pixels the overlay panels cover at the top and bottom of the canvas. The
  // view is shifted so the model sits in the free band between them (phones).
  let insets = { top: 0, bottom: 0 };
  function freeBand(h) {
    const band = h - insets.top - insets.bottom;
    return band >= 120 ? band : h;
  }
  function applyViewOffset() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    if (freeBand(h) === h) camera.clearViewOffset();
    else camera.setViewOffset(w, h, 0, (insets.bottom - insets.top) / 2, w, h);
    camera.updateProjectionMatrix();
  }

  function frameCamera() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    applyViewOffset();
    // Narrow (portrait phone) viewports need the camera further back to fit
    // the plate's width; a short free band, its height.
    // The plate is seen corner-on while it orbits, so fit its diagonal.
    const span = Math.hypot(model.footprint.width, model.footprint.depth);
    const fitDistance =
      (span * 1.12) / ((2 * Math.tan((camera.fov * Math.PI) / 360) * Math.min(freeBand(h), w)) / h);
    const dir = new THREE.Vector3(0.62, 0.72, 0.92).normalize();
    camera.position
      .copy(controls.target)
      .addScaledVector(dir, Math.min(controls.maxDistance, Math.max(0.6, fitDistance)));
    controls.update();
  }
  const resizeObserver = new ResizeObserver(() => {
    if (!renderer.xr.isPresenting) frameCamera();
  });
  resizeObserver.observe(container);
  frameCamera();

  // ── Selection: tap/click a bar (orbit) or select with the XR ray ──
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  function barHit(ray) {
    raycaster.ray.copy(ray);
    return raycaster.intersectObjects(model.bars, false)[0] || null;
  }
  function pick(ray) {
    const hit = barHit(ray);
    onSelectDistrict(hit ? hit.object.userData.district.id : null);
  }
  const onPointerDown = (event) => {
    downAt = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event) => {
    if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 6) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    pick(raycaster.ray);
  };
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);

  // ── In-scene provenance label (shown in VR, where no DOM overlay exists) ──
  let label = null;
  function setLabel(lines) {
    if (label) {
      anchor.remove(label.sprite);
      label.dispose();
    }
    label = makeLabelSprite(lines);
    label.sprite.position.set(0, 0.29, -model.footprint.depth / 2);
    label.sprite.visible = panel.mesh.visible;
    anchor.add(label.sprite);
  }

  // ── In-scene scenario panel: a lectern in front of the model, tilted up
  // toward the viewer. Only shown in a session without a DOM overlay. ──
  const panel = createScenePanel();
  const tilt = 0.6;
  panel.mesh.rotation.x = -tilt;
  panel.mesh.position.set(
    0,
    (PANEL_HEIGHT_M / 2) * Math.cos(tilt) + 0.004,
    model.footprint.depth / 2 + 0.03 + (PANEL_HEIGHT_M / 2) * Math.sin(tilt),
  );
  anchor.add(panel.mesh);

  // ── XR state ──
  let session = null;
  let sessionKind = null;
  let domOverlay = false;
  let disposed = false;
  let hitTestSource = null;
  // The controller whose target ray the placement hit test follows (null: the viewer).
  let hitTestInput = null;
  let placed = false;
  // A visible pointer ray so a headset user can aim at the panel's buttons.
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]);
  const rayMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
  const tempMatrix = new THREE.Matrix4();
  function controllerRay(controller) {
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    return new THREE.Ray(
      new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld),
      new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix),
    );
  }
  function syncPanel() {
    panel.mesh.visible = sessionKind === "immersive-vr" || (sessionKind === "immersive-ar" && !domOverlay);
    // Provenance rides with the model wherever the DOM overlay is missing.
    if (label) label.sprite.visible = panel.mesh.visible;
    controllers.forEach((controller) => {
      const pointer = controller.userData.source?.targetRayMode === "tracked-pointer";
      controller.userData.rayLine.visible =
        sessionKind === "immersive-vr" || (sessionKind === "immersive-ar" && pointer);
    });
  }
  // A two-finger gesture on the AR overlay also produces screen selects; they
  // must not place or pick behind the gesture.
  let holdSelectUntil = 0;
  // Short haptic tick on a phone, so a tap on the table is felt (no-op elsewhere).
  const tick = () => navigator.vibrate?.(12);
  function onSelect(event) {
    if (performance.now() < holdSelectUntil) return;
    const ray = controllerRay(event.target);
    let panelHit = null;
    if (panel.mesh.visible) {
      raycaster.ray.copy(ray);
      panelHit = panel.hit(raycaster);
    }
    const hit = sessionKind ? barHit(ray) : null;
    const action = selectAction({
      sessionKind,
      panelHit,
      placed,
      reticleVisible: reticle.visible,
      barHit: Boolean(hit),
    });
    if (action === "control") onControl(panelHit);
    else if (action === "pick") {
      tick();
      onSelectDistrict(hit.object.userData.district.id);
    } else if (action === "clear") onSelectDistrict(null);
    else if (action === "place") {
      tick();
      anchor.position.setFromMatrixPosition(reticle.matrix);
      anchor.visible = true;
      placed = true;
      reticle.visible = false;
      onArStage("placed");
    }
  }

  // Quest: squeeze grabs the placed model with that controller and moves it with
  // the hand; on release it stays where it was let go, set level on the table.
  let grabbedBy = null;
  const yaw = new THREE.Euler();
  function release() {
    if (!grabbedBy) return;
    scene3.attach(anchor);
    yaw.setFromQuaternion(anchor.quaternion, "YXZ");
    anchor.rotation.set(0, yaw.y, 0);
    grabbedBy = null;
  }
  function onSqueezeStart(event) {
    const canGrab = sessionKind === "immersive-vr" || (sessionKind === "immersive-ar" && placed);
    if (!canGrab || grabbedBy) return;
    grabbedBy = event.target;
    grabbedBy.attach(anchor);
  }
  function onSqueezeEnd(event) {
    if (event.target === grabbedBy) release();
  }
  // Both hands on a headset: a select arrives on the controller that made it.
  const controllers = [0, 1].map((index) => {
    const controller = renderer.xr.getController(index);
    const rayLine = new THREE.Line(rayGeometry, rayMaterial);
    rayLine.visible = false;
    controller.add(rayLine);
    controller.userData.rayLine = rayLine;
    controller.addEventListener("connected", (event) => {
      controller.userData.source = event.data;
      syncPanel();
    });
    controller.addEventListener("disconnected", () => {
      controller.userData.source = null;
      syncPanel();
    });
    controller.addEventListener("select", onSelect);
    controller.addEventListener("squeezestart", onSqueezeStart);
    controller.addEventListener("squeezeend", onSqueezeEnd);
    scene3.add(controller);
    return controller;
  });

  function resetAnchor() {
    release();
    anchor.position.set(0, 0, 0);
    anchor.rotation.set(0, 0, 0);
    anchor.scale.setScalar(1);
    anchor.visible = true;
  }

  function onSessionEnd(event) {
    // A late "end" from an earlier session must not reset the current one.
    if (event?.session && session && event.session !== session) return;
    hitTestSource?.cancel?.();
    hitTestSource = null;
    hitTestInput = null;
    session = null;
    sessionKind = null;
    domOverlay = false;
    syncPanel();
    placed = false;
    reticle.visible = false;
    scene3.background = background;
    floor.visible = true;
    resetAnchor();
    frameCamera();
    onSessionChange(null);
  }

  // Adopt a freshly granted session. Every later await re-checks that the
  // session is still ours and alive (the user can end it, or the page can
  // unmount, mid-setup); any setup failure ends the session so the device
  // never stays in an immersive mode the page has given up on.
  function adopt(next, kind) {
    let ended = false;
    next.addEventListener(
      "end",
      () => {
        ended = true;
      },
      { once: true },
    );
    session = next;
    sessionKind = kind;
    next.addEventListener("end", onSessionEnd);
    return () => !disposed && !ended && session === next;
  }

  function abandon(next) {
    if (session === next) next.end().catch(() => {});
  }

  async function startAr(overlayRoot) {
    const next = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "local-floor"],
      domOverlay: { root: overlayRoot },
    });
    if (disposed) {
      next.end().catch(() => {});
      return;
    }
    const live = adopt(next, "immersive-ar");
    try {
      renderer.xr.setReferenceSpaceType("local");
      await renderer.xr.setSession(next);
      if (!live()) return;
      scene3.background = null; // camera passthrough
      floor.visible = false;
      resetAnchor();
      anchor.visible = false;
      placed = false;
      const viewerSpace = await next.requestReferenceSpace("viewer");
      if (!live()) return;
      // Phones aim the placement with the camera centre (viewer ray); a headset
      // with controllers (Quest) aims it with the controller's target ray, and
      // switches whenever controllers connect or disconnect.
      let request = 0;
      const refreshHitTest = async () => {
        const pointer = hitTestPointer(next.inputSources);
        if (hitTestSource && pointer === hitTestInput) return;
        const mine = ++request;
        const space = pointer ? pointer.targetRaySpace : viewerSpace;
        const source = await next.requestHitTestSource({ space });
        if (!live() || mine !== request) {
          source?.cancel?.();
          return;
        }
        hitTestSource?.cancel?.();
        hitTestSource = source;
        hitTestInput = pointer;
      };
      await refreshHitTest();
      if (!live()) return;
      next.addEventListener("inputsourceschange", () => {
        if (live()) refreshHitTest().catch(() => {});
      });
      // Without a granted DOM overlay the scenario controls move into the scene.
      domOverlay = Boolean(next.domOverlayState);
      syncPanel();
      onSessionChange("immersive-ar");
      onArStage("scanning");
    } catch (error) {
      abandon(next);
      throw error;
    }
  }

  async function startVr() {
    const next = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
    if (disposed) {
      next.end().catch(() => {});
      return;
    }
    const live = adopt(next, "immersive-vr");
    try {
      renderer.xr.setReferenceSpaceType("local-floor");
      await renderer.xr.setSession(next);
      if (!live()) return;
      floor.visible = false;
      resetAnchor();
      // A diorama at table height, a comfortable arm's length ahead.
      anchor.position.copy(VR_ANCHOR);
      anchor.scale.setScalar(1.5);
      syncPanel();
      onSessionChange("immersive-vr");
    } catch (error) {
      abandon(next);
      throw error;
    }
  }

  let last = performance.now();
  let firstFrame = null;
  const firstFramePromise = new Promise((resolve) => {
    firstFrame = resolve;
  });
  // The plate image is the largest download on /xr: fetch it once the city is drawn.
  firstFramePromise.then(() => {
    if (!disposed) model.loadPlate();
  });
  renderer.setAnimationLoop((time, frame) => {
    const now = performance.now();
    // Lite orbit viewer: ~30 fps leaves an entry GPU headroom (an XR frame always renders).
    if (lite && !frame && now - last < LITE_RENDER.orbitFrameMs) return;
    const dt = (now - last) / 1000;
    last = now;
    model.tick(dt);
    if (frame && hitTestSource && !placed) {
      const results = frame.getHitTestResults(hitTestSource);
      const space = renderer.xr.getReferenceSpace();
      const pose = results.length && space ? results[0].getPose(space) : null;
      if (pose) {
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        onArStage("ready");
      } else {
        reticle.visible = false;
        onArStage("scanning");
      }
    }
    if (!renderer.xr.isPresenting) controls.update();
    renderer.render(scene3, camera);
    if (firstFrame) {
      firstFrame();
      firstFrame = null;
    }
  });

  return {
    bars: model.bars.length,
    firstFrame: firstFramePromise,
    setDay: (i) => model.setDay(i),
    setScene: (next, i) => model.setScene(next, i),
    setHighlight: (id) => model.setHighlight(id),
    stats: () => ({
      ...model.stats(),
      pixelRatio: renderer.getPixelRatio(),
      antialias: Boolean(renderer.getContext().getContextAttributes()?.antialias),
      shadows: renderer.shadowMap.enabled,
    }),
    // Client coordinates of a district's column (inline viewer only), for tests.
    screenPoint: (id) => {
      const mesh = model.bars.find((bar) => bar.userData.district.id === id);
      if (!mesh || renderer.xr.isPresenting) return null;
      const { anchor: at } = mesh.userData;
      const point = model.root
        .localToWorld(new THREE.Vector3(at.x, mesh.scale.y * 0.5, at.z))
        .project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return {
        x: rect.left + ((point.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - point.y) / 2) * rect.height,
      };
    },
    setPanel: (spec) => panel.draw(spec),
    panelText: () => panel.text(),
    setLabel,
    labelText: () => label?.sprite.userData.text || null,
    startAr,
    startVr,
    endSession: () => session?.end(),
    rotate: (deg) => {
      anchor.rotation.y += (deg * Math.PI) / 180;
    },
    holdSelect: (ms) => {
      holdSelectUntil = Math.max(holdSelectUntil, performance.now() + ms);
    },
    setInsets: (top, bottom) => {
      const next = { top: Math.max(0, Math.round(top)), bottom: Math.max(0, Math.round(bottom)) };
      if (Math.abs(next.top - insets.top) < 4 && Math.abs(next.bottom - insets.bottom) < 4) return;
      insets = next;
      if (!renderer.xr.isPresenting) applyViewOffset();
    },
    scale: (factor) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, anchor.scale.x * factor));
      anchor.scale.setScalar(next);
    },
    replace: () => {
      placed = false;
      anchor.visible = false;
      onArStage("scanning");
    },
    dispose: () => {
      disposed = true;
      renderer.setAnimationLoop(null);
      if (session) {
        session.removeEventListener("end", onSessionEnd);
        session.end().catch(() => {});
      }
      hitTestSource?.cancel?.();
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      label?.dispose();
      panel.dispose();
      rayGeometry.dispose();
      rayMaterial.dispose();
      model.dispose();
      floorGeometry.dispose();
      floorMaterial.dispose();
      reticleGeometry.dispose();
      reticleMaterial.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

// The imagery licence credit is legal text (untranslated), split over two panel lines.
function imageryCreditLines(label) {
  const cut = IMAGERY_CREDIT.indexOf(" (");
  return cut > 0
    ? [`${label}: ${IMAGERY_CREDIT.slice(0, cut)}`, IMAGERY_CREDIT.slice(cut + 1)]
    : [`${label}: ${IMAGERY_CREDIT}`];
}

const PROVENANCE_KEYS = {
  MODEL_OUTPUT: ["xr_prov_model", "xr_prov_model_note"],
  SIMULATED_DEMO_CITY: ["xr_prov_demo", "xr_prov_demo_note"],
};

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Android without ARCore (or without a WebXR browser) falls back to orbit: say why.
const IS_ANDROID = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");

export function XrTabletop() {
  const { t, lang, setLang } = useLanguage();
  const params = useMemo(readParams, []);
  const [cityScene, setCityScene] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [sceneLoading, setSceneLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The shared part of the view: what the group around the table looks at.
  const [scenario, setScenario] = useState(() => ({
    rain: params.rain,
    eventPreset: params.eventPreset,
    day: params.day,
    // The horizon day the what-if (rain / event) applies to.
    scenarioDay: params.day,
    agreed: false,
    // The district pointed at on any device in the session (last writer wins).
    selectedId: null,
    // An event venue set by Ask Pythia (a twin venue id); null keeps the linked/default venue.
    venueId: null,
    // The decision room's briefing scenario on the table, or null for a free what-if.
    scenarioId: params.scenarioId,
  }));
  const [mode, setMode] = useState("detecting");
  const [session, setSession] = useState(null);
  const [arStage, setArStage] = useState("scanning");
  const [participants, setParticipants] = useState(0);
  const [engineState, setEngineState] = useState({ ready: false, bars: 0, error: false });
  // Lite mode for budget phones (xrLite.js): auto-detected, with a manual toggle.
  const [liteState, setLiteState] = useState(() => detectLite());
  const { lite } = liteState;
  const [xrError, setXrError] = useState("");
  const [sessionCode, setSessionCode] = useState(params.session);
  const [sessionErrorKey, setSessionErrorKey] = useState("");
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  // Presets, sharing and the legend fold into a bottom sheet on phones, and the
  // header into one line, so the city takes most of the screen (gsc-2026 #3).
  const [scenarioOpen, setScenarioOpen] = useState(
    () => !window.matchMedia || window.matchMedia("(min-width: 700px)").matches,
  );
  const [headOpen, setHeadOpen] = useState(
    () => !window.matchMedia || window.matchMedia("(min-width: 481px)").matches,
  );
  // Ask Pythia on the table (gsc-2026 #7).
  const [question, setQuestion] = useState("");
  const [ask, setAsk] = useState({ status: "idle", asked: "", result: null });
  // Random per-page id for presence heartbeats; never a name or an account.
  const participantRef = useRef(null);
  const mountRef = useRef(null);
  const overlayRef = useRef(null);
  const engineRef = useRef(null);
  const sceneRef = useRef(null);
  sceneRef.current = cityScene;
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  // Last-writer-wins bookkeeping: local edits not yet sent, writes in flight,
  // and the newest server `updated_at` already applied or written.
  const localRevRef = useRef(0);
  const pushedRevRef = useRef(0);
  const pendingRef = useRef(0);
  const seenRef = useRef(0);
  const { day } = scenario;
  const dayCount = cityScene?.horizon?.dates?.length || 0;
  const venue =
    (scenario.venueId && TWIN_VENUES[params.city]?.find((v) => v.id === scenario.venueId)) || params.venue;
  const query = sceneQuery(params.city, scenario, venue);

  useEffect(() => {
    if (params.lang === "en" || params.lang === "id") setLang(params.lang);
    // Run once: the URL parameter only seeds the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A scenario change re-fetches the scene; the previous one stays on the
  // table until the new one arrives, so the columns can grow into it. Edits
  // are debounced and a superseded request is aborted (gsc M5); a failed
  // refetch keeps the scene on the table, so only a first load reports it.
  useEffect(() => {
    const controller = new AbortController();
    setSceneLoading(true);
    const timer = setTimeout(
      async () => {
        try {
          const response = await apiFetch(`/twin/scene?${query}`, { signal: controller.signal });
          if (!response.ok) throw new Error(String(response.status));
          const body = await response.json();
          setCityScene(body);
          setLoadError(false);
          setSceneLoading(false);
        } catch (error) {
          if (error.name === "AbortError") return;
          if (!sceneRef.current) setLoadError(true);
          setSceneLoading(false);
        }
      },
      sceneRef.current ? SCENE_DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, attempt]);

  // Capability → mode. Never assume XR: ask the browser.
  useEffect(() => {
    let alive = true;
    (async () => {
      let next = "orbit";
      const xr = navigator.xr;
      if (xr?.isSessionSupported) {
        try {
          if (await xr.isSessionSupported("immersive-ar")) next = "ar";
          else if (await xr.isSessionSupported("immersive-vr")) next = "vr";
        } catch {
          next = "orbit";
        }
      }
      if (alive) setMode(next);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Every local edit goes through here. Changing what is on the table (rain or
  // event) withdraws an earlier agreement: it was for a different scenario.
  const changeScenario = useCallback((patch) => {
    localRevRef.current += 1;
    setScenario((prev) => {
      const change = typeof patch === "function" ? patch(prev) : patch;
      const next = { ...prev, ...change };
      const moved =
        next.rain !== prev.rain ||
        next.eventPreset !== prev.eventPreset ||
        next.venueId !== prev.venueId ||
        next.scenarioDay !== prev.scenarioDay;
      if (!("agreed" in change) && moved) {
        next.agreed = false;
      }
      // A hand-made what-if is no longer the briefing scenario.
      if (!("scenarioId" in change) && moved) next.scenarioId = null;
      return next;
    });
  }, []);

  // gsc m6: writes are serialized — one PUT in flight, and a write still
  // waiting when a newer edit arrives is skipped (the newer one carries the
  // whole scenario), so the server can never end on an older state.
  const pushTailRef = useRef(Promise.resolve());
  const pushSeqRef = useRef(0);
  const putSession = useCallback(
    async (code, state, seq) => {
      try {
        if (seq !== pushSeqRef.current) return true;
        const res = await apiFetch(`/xr/session/${code}`, {
          method: "PUT",
          auth: false,
          body: {
            city: params.city,
            rainfall_mm: state.rain,
            event_preset: state.eventPreset,
            day: state.day,
            agreed: state.agreed,
            selected_id: state.selectedId || null,
            venue_id: state.venueId || null,
            scenario_day: state.scenarioDay,
            scenario_id: state.scenarioId || null,
          },
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        seenRef.current = Math.max(seenRef.current, Date.parse(body.updated_at) || 0);
        setSessionErrorKey("");
        return true;
      } catch {
        setSessionErrorKey("xr_session_error");
        return false;
      } finally {
        pendingRef.current -= 1;
      }
    },
    [params.city],
  );

  const pushSession = useCallback(
    (code, state) => {
      pushSeqRef.current += 1;
      const seq = pushSeqRef.current;
      // Counted from the moment it is queued, so polling never applies an
      // older server state over an edit still waiting to go out.
      pendingRef.current += 1;
      const run = pushTailRef.current.then(() => putSession(code, state, seq));
      pushTailRef.current = run;
      return run;
    },
    [putSession],
  );

  // Local edits → the shared session.
  useEffect(() => {
    if (!sessionCode || localRevRef.current === pushedRevRef.current) return;
    pushedRevRef.current = localRevRef.current;
    pushSession(sessionCode, scenario);
  }, [scenario, sessionCode, pushSession]);

  // The shared session → this device: poll while the page is visible.
  useEffect(() => {
    if (!sessionCode) return undefined;
    let alive = true;
    let timer = null;
    let inFlight = false;
    const hidden = () => document.visibilityState === "hidden";
    const schedule = () => {
      if (alive && !timer && !inFlight && !hidden()) timer = setTimeout(run, POLL_MS);
    };
    if (!participantRef.current) participantRef.current = makeSessionCode(16);
    async function run() {
      timer = null;
      inFlight = true;
      try {
        // Each poll is also this device's presence heartbeat (10 s TTL on the server).
        const res = await apiFetch(`/xr/session/${sessionCode}/presence`, {
          method: "POST",
          auth: false,
          body: { participant_id: participantRef.current },
        });
        if (!alive) return;
        if (res.status === 404) {
          setSessionErrorKey("xr_session_missing");
          setSessionCode(null);
          setParticipants(0);
          // gsc n32: an expired code must not come back on reload or in a shared link.
          const url = new URL(window.location.href);
          url.searchParams.delete("session");
          window.history.replaceState(window.history.state, "", url);
          alive = false;
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        if (!alive) return;
        setSessionErrorKey("");
        if (Number.isInteger(body.participants)) setParticipants(body.participants);
        const stamp = Date.parse(body.updated_at) || 0;
        // Ignore anything older than what this device already wrote or applied,
        // and anything that would overwrite an edit still on its way out.
        const busy = pendingRef.current > 0 || localRevRef.current !== pushedRevRef.current;
        if (busy || stamp <= seenRef.current) return;
        seenRef.current = stamp;
        if (body.city !== params.city) {
          alive = false;
          window.location.assign(`/xr?session=${sessionCode}&city=${body.city}`);
          return;
        }
        setScenario({
          rain: body.rainfall_mm,
          eventPreset: body.event_preset,
          day: body.day,
          agreed: body.agreed,
          selectedId: body.selected_id || null,
          venueId: body.venue_id || null,
          scenarioDay: Number.isInteger(body.scenario_day) ? body.scenario_day : 0,
          scenarioId: body.scenario_id || null,
        });
      } catch {
        if (alive) setSessionErrorKey("xr_session_error");
      } finally {
        inFlight = false;
        schedule();
      }
    }
    const onVisibility = () => {
      if (hidden()) {
        clearTimeout(timer);
        timer = null;
      } else if (!timer && !inFlight) {
        run();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (!hidden()) run();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sessionCode, params.city]);

  const share = async (state = scenarioRef.current) => {
    if (sessionCode || sharing) return false;
    setSharing(true);
    const code = makeSessionCode();
    pushedRevRef.current = localRevRef.current;
    const ok = await pushSession(code, state);
    setSharing(false);
    if (!ok) return false;
    setSessionCode(code);
    const url = new URL(window.location.href);
    url.searchParams.set("session", code);
    url.searchParams.set("city", params.city);
    window.history.replaceState(window.history.state, "", url);
    return true;
  };

  const toggleAgree = () => {
    const agreed = !scenarioRef.current.agreed;
    changeScenario({ agreed });
    // Agreement is recorded in a shared session; start one if there is none.
    // Without a session to hold it, there is no agreement to show.
    if (agreed && !sessionCode) {
      share({ ...scenarioRef.current, agreed }).then((ok) => {
        if (!ok) changeScenario({ agreed: false });
      });
    }
  };

  // The decision room: a briefing scenario goes on the table for today (and to every
  // joined device); choosing it again returns to the plain forecast.
  const chooseScenario = (id) => {
    const picked = scenario.scenarioId === id ? null : twinScenario(id);
    changeScenario({
      scenarioId: picked ? picked.id : null,
      rain: picked ? picked.rain : 0,
      eventPreset: picked ? picked.event : "none",
      venueId: picked?.venue || null,
      day: 0,
      scenarioDay: 0,
      selectedId: null,
    });
  };

  // Today's canonical baseline beside the briefing scenario (/api/twin/briefing, the
  // twin's own comparison), so the table prints the twin's numbers.
  const [briefing, setBriefing] = useState(null);
  useEffect(() => {
    if (!scenario.scenarioId) {
      setBriefing(null);
      return undefined;
    }
    const controller = new AbortController();
    apiFetch(`/twin/briefing?scenario=${encodeURIComponent(scenario.scenarioId)}`, {
      auth: false,
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setBriefing(body))
      .catch(() => {});
    return () => controller.abort();
  }, [scenario.scenarioId]);

  const stepDay = (delta) =>
    changeScenario((prev) => ({ day: Math.min(Math.max(0, dayCount - 1), Math.max(0, prev.day + delta)) }));

  // Ask Pythia: the twin Ask rail's endpoint (/assistant/query) when this device
  // is signed in to the command center; otherwise the public /xr/ask, which runs
  // the same local parser and read-only run_scenario tool. The scenario the tool
  // ran goes onto the table through changeScenario, so a shared session pushes it
  // to every joined device.
  const askSeqRef = useRef(0);
  const askPythia = async (text = question) => {
    const prompt = text.trim();
    if (!prompt || ask.status === "loading") return;
    const seq = ++askSeqRef.current;
    setQuestion("");
    setAsk({ status: "loading", asked: prompt, result: null });
    const body = { question: prompt, language: lang, history: [] };
    try {
      let res = await apiFetch("/assistant/query", { method: "POST", body });
      if (res.status === 401 || res.status === 403) {
        res = await apiFetch("/xr/ask", {
          method: "POST",
          auth: false,
          // A joined table is rate-limited per session, not per venue address.
          body: sessionCode
            ? { question: prompt, language: lang, session: sessionCode }
            : { question: prompt, language: lang },
        });
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (seq !== askSeqRef.current) return;
      const patch = askToScenario(data.scenario, params.city);
      if (!patch) {
        setAsk({ status: "none", asked: prompt, result: null });
      } else if (patch.otherCity) {
        setAsk({
          status: "other-city",
          asked: prompt,
          result: { ...data.scenario, otherCity: patch.otherCity },
        });
      } else {
        changeScenario({ ...patch, scenarioDay: patch.day, selectedId: null });
        setAsk({ status: "applied", asked: prompt, result: data.scenario, provider: data.provider });
      }
    } catch {
      if (seq === askSeqRef.current) setAsk({ status: "error", asked: prompt, result: null });
    }
  };
  const voice = useSpeechInput(lang, (transcript) => {
    setQuestion(transcript);
    askPythia(transcript);
  });

  // Buttons of the in-scene panel (headset / AR without DOM overlay).
  const onControl = (id) => {
    const [kind, value] = id.split(":");
    if (kind === "rain") changeScenario((prev) => ({ rain: Number(value), scenarioDay: prev.day }));
    else if (kind === "event") changeScenario((prev) => ({ eventPreset: value, scenarioDay: prev.day }));
    else if (id === "day-prev") stepDay(-1);
    else if (id === "day-next") stepDay(1);
    else if (id === "agree") toggleAgree();
  };
  const controlRef = useRef(onControl);
  controlRef.current = onControl;

  // Engine lifecycle: one renderer per city, torn down on unmount. Later
  // scenarios of the same city are applied in place (see setScene below), so
  // an immersive session survives a scenario change.
  const hasScene = Boolean(cityScene);
  useEffect(() => {
    if (!hasScene || !mountRef.current) return undefined;
    let engine;
    let alive = true;
    try {
      engine = createEngine({
        container: mountRef.current,
        cityScene: sceneRef.current,
        dayIndex: scenarioRef.current.day,
        plate: CITY_PLATES[params.city] || null,
        // A pick is shared with the session; a repeat of the current one is not news.
        onSelectDistrict: (id) => {
          if (id !== scenarioRef.current.selectedId) changeScenario({ selectedId: id });
        },
        onArStage: (stage) => setArStage((prev) => (prev === stage ? prev : stage)),
        onSessionChange: (kind) => setSession(kind),
        onControl: (id) => controlRef.current(id),
        lite,
      });
    } catch {
      setEngineState({ ready: false, bars: 0, error: true });
      return undefined;
    }
    engineRef.current = engine;
    engine.firstFrame.then(() => {
      if (alive) setEngineState({ ready: true, bars: engine.bars, error: false });
    });
    return () => {
      alive = false;
      engineRef.current = null;
      engine.dispose();
    };
    // params and changeScenario are stable: the engine is built once per city
    // (and again when lite mode changes the renderer's context attributes).
  }, [hasScene, params.city, changeScenario, lite]);

  const toggleLite = () => {
    const next = !lite;
    storeLite(next);
    // The new engine reports ready on its first frame; the scene, highlight,
    // label and panel effects then re-apply to it.
    setEngineState((prev) => ({ ...prev, ready: false }));
    setLiteState((prev) => ({ ...prev, lite: next, source: "manual" }));
  };

  useEffect(() => {
    if (cityScene) engineRef.current?.setScene(cityScene, day);
  }, [cityScene, day, engineState.ready]);

  const { selectedId } = scenario;
  useEffect(() => {
    engineRef.current?.setHighlight(selectedId);
  }, [selectedId, engineState.ready]);

  // Provenance travels into the headset with the model (see makeLabelSprite).
  const labelProvenance = cityScene?.provenance?.districts || {};
  const [labelKey, labelNoteKey] = PROVENANCE_KEYS[labelProvenance.class] || [];
  const labelCity = cityScene?.city?.name || "";
  const labelClass = labelKey ? t(labelKey) : labelProvenance.class || "";
  const hcmcNote = t("xr3_hcmc_boundaries");
  const labelNote = [
    labelNoteKey ? t(labelNoteKey) : labelProvenance.source || "",
    params.city === "hcmc" && hcmcNote,
  ]
    .filter(Boolean)
    .join(" · ");
  useEffect(() => {
    if (!engineState.ready || !labelCity) return;
    engineRef.current?.setLabel([`${labelCity} · ${labelClass}`, labelNote]);
  }, [engineState.ready, labelCity, labelClass, labelNote]);

  // A tap on any DOM-overlay panel (header, selected district, controls) must
  // not double as an XR "select" (place / pick) behind it. beforexrselect
  // bubbles from the tapped element to the overlay root.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return undefined;
    const block = (event) => {
      if (event.target instanceof Element && event.target.closest(".xr-panel, .xr-controls, .xr-credit"))
        event.preventDefault();
    };
    el.addEventListener("beforexrselect", block);
    return () => el.removeEventListener("beforexrselect", block);
  }, []);

  // Phones: the header and the bottom sheet span the screen, so the view is
  // centred in the band between them (a side panel on a wide screen is ignored).
  const headRef = useRef(null);
  const controlsRef = useRef(null);
  useEffect(() => {
    const shell = mountRef.current;
    if (!engineState.ready || !hasScene || !shell) return undefined;
    const measure = () => {
      const box = shell.getBoundingClientRect();
      const spans = (r) => r && r.height > 0 && r.width >= box.width * 0.8;
      const head = headRef.current?.getBoundingClientRect();
      const foot = controlsRef.current?.getBoundingClientRect();
      engineRef.current?.setInsets(
        spans(head) ? head.bottom - box.top : 0,
        spans(foot) ? box.bottom - foot.top : 0,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    [shell, headRef.current, controlsRef.current].forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [engineState.ready, hasScene]);

  // gsc-2026 #12: in an AR session, two fingers on the camera view pinch to scale
  // and twist to rotate the placed city (the buttons stay as the accessible path).
  // Selects made by those fingers are held so they never place or pick.
  useEffect(() => {
    const el = overlayRef.current;
    if (session !== "immersive-ar" || !el) return undefined;
    const points = new Map();
    let last = null;
    const pair = () => Array.from(points.values()).slice(0, 2);
    const down = (event) => {
      if (event.target instanceof Element && event.target.closest(".xr-panel, .xr-controls, .xr-credit"))
        return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (points.size >= 2) {
        last = pair();
        engineRef.current?.holdSelect(400);
      }
    };
    const move = (event) => {
      if (!points.has(event.pointerId)) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (points.size < 2 || !last) return;
      const next = pair();
      const change = twoFingerChange(last, next);
      last = next;
      engineRef.current?.holdSelect(400);
      if (!change) return;
      engineRef.current?.scale(change.scale);
      engineRef.current?.rotate(change.rotateDeg);
    };
    const up = (event) => {
      points.delete(event.pointerId);
      if (points.size < 2) last = null;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [session]);

  const enterAr = async () => {
    setXrError("");
    try {
      await engineRef.current?.startAr(overlayRef.current);
    } catch {
      setXrError(t("xr_session_failed"));
    }
  };
  const enterVr = async () => {
    setXrError("");
    try {
      await engineRef.current?.startVr();
    } catch {
      setXrError(t("xr_session_failed"));
    }
  };

  const copyLink = (url) => {
    navigator.clipboard
      ?.writeText(url)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const locale = localeFor(lang);
  const dates = cityScene?.horizon?.dates || [];
  const dateLabel = (iso) =>
    iso
      ? new Date(`${iso}T00:00:00`).toLocaleDateString(locale, {
          weekday: "short",
          day: "numeric",
          month: "short",
        })
      : "—";
  const tonnes = (n) => `${Math.round(n).toLocaleString(locale)} t`;
  const districts = cityScene?.districts || [];
  const totalToday = cityScene?.horizon?.daily_total_tons?.[day] ?? 0;
  const atRisk = districts.filter((d) => ["high", "critical"].includes(dayRisk(d, day))).length;
  // Each day's at-risk count on the scrubber (teardown v3 fix 6).
  const weekRisk = dailyRisk(cityScene);
  // Readout for the selected day, straight from the scene payload: the same
  // model without rain or event is the "normal day"; trucks are the scene's
  // per-district trucks_required (one crew team per truck, per core/units).
  const dayRows = districts.map((d) => d.series?.[day] || d.series?.[0]).filter(Boolean);
  const extraTons = dayRows.reduce(
    (sum, row) =>
      sum + (row.predicted_tons - (finiteNumber(row.normal_tons) ? row.normal_tons : row.predicted_tons)),
    0,
  );
  const trucksNeeded = dayRows.reduce((sum, row) => sum + (row.trucks_required || 0), 0);
  // Crews come from the scene when it sends them (horizon, today's summary or
  // per-district series); without them the readout keeps "one crew per truck".
  const dailyCrews = cityScene?.horizon?.daily_crews_required?.[day];
  const crewsNeeded = finiteNumber(dailyCrews)
    ? dailyCrews
    : day === 0 && finiteNumber(cityScene?.summary?.crews_required_today)
      ? cityScene.summary.crews_required_today
      : dayRows.length && dayRows.every((row) => finiteNumber(row.crews_required))
        ? dayRows.reduce((sum, row) => sum + row.crews_required, 0)
        : null;
  const extraLabel = `${extraTons >= 0 ? "+" : "−"}${tonnes(Math.abs(extraTons))}`;
  const queue = cityScene?.landfill_queue?.minutes_per_truck;
  // gsc M5: the scene is fetched for today; the queue metric names the day the
  // backend computed it for, not the day being stepped through.
  const queueDay = finiteNumber(cityScene?.scenario?.day) ? cityScene.scenario.day : 0;
  const minutes = (n) => n.toLocaleString(locale, { maximumFractionDigits: 1 });
  // gsc-2026 #4: the queue says what each number is, in the twin's words — the day
  // average without → with stagger, the modelled peak hour of the unstaggered arm,
  // and the unstaggered range over assumed departure spreads (not a confidence interval).
  const queueScaled =
    queue?.scenario_scaled === true &&
    finiteNumber(queue.normal_day?.baseline_mean) &&
    finiteNumber(queue.normal_day?.staggered_mean);
  const queueLabel =
    queue && finiteNumber(queue.baseline_mean) && finiteNumber(queue.staggered_mean)
      ? t("xr3_queue_day_mean")
          .replace("{base}", minutes(queue.baseline_mean))
          .replace("{stag}", minutes(queue.staggered_mean))
      : null;
  const beacon = cityScene?.landfill_queue;
  const queuePeak =
    queueLabel && Number.isInteger(beacon?.modelled_hour) && finiteNumber(beacon.avg_wait_minutes)
      ? t("xr3_queue_peak")
          .replace("{hour}", `${String(beacon.modelled_hour).padStart(2, "0")}:00`)
          .replace("{trucks}", Number(beacon.trucks_in_queue ?? 0).toLocaleString(locale))
          .replace("{wait}", minutes(beacon.avg_wait_minutes))
      : null;
  const band = queue?.sensitivity?.baseline_band;
  const spreads = queue?.assumptions?.sensitivity_departure_sd_minutes;
  const queueBand =
    queueLabel && Array.isArray(band) && band.every(finiteNumber) && Array.isArray(spreads) && spreads.length
      ? t("xr3_queue_band")
          .replace("{low}", minutes(band[0]))
          .replace("{high}", minutes(band[1]))
          .replace("{sd_low}", minutes(Math.min(...spreads)))
          .replace("{sd_high}", minutes(Math.max(...spreads)))
      : null;
  const queueNormal = queueScaled
    ? t("xr3_queue_normal")
        .replace("{base}", minutes(queue.normal_day.baseline_mean))
        .replace("{stag}", minutes(queue.normal_day.staggered_mean))
    : null;
  const queueTrips =
    queueLabel && finiteNumber(queue.trucks_per_day)
      ? t(queue.scenario_scaled ? "xr3_queue_trips_scaled" : "xr3_queue_trips_real").replace(
          "{n}",
          queue.trucks_per_day.toLocaleString(locale),
        )
      : null;
  // Equal truck and crew counts are the one-crew-per-truck rule (core/units): name it,
  // with the scene's crew size, so "573 = 573" does not read as a bug.
  const crewSize = cityScene?.summary?.crew_size_workers;
  const crewRule =
    crewsNeeded !== null && crewsNeeded === trucksNeeded && finiteNumber(crewSize)
      ? t("units_crew_per_truck").replace("{n}", crewSize.toLocaleString(locale))
      : null;
  const fleetText =
    crewsNeeded === null
      ? `${trucksNeeded.toLocaleString(locale)} ${t("xr_metric_fleet")}`
      : [
          `${trucksNeeded.toLocaleString(locale)} ${t("xr_metric_trucks")}`,
          `${crewsNeeded.toLocaleString(locale)} ${t("xr_metric_crews")}`,
          crewRule,
        ]
          .filter(Boolean)
          .join(" · ");
  const provenance = cityScene?.provenance?.districts || {};
  const [provLabelKey, provNoteKey] = PROVENANCE_KEYS[provenance.class] || [];
  // gsc-2026 #13: Vietnam abolished the district tier on 1 July 2025; the demo city says
  // which boundaries it draws.
  const provNote = [provNoteKey ? t(provNoteKey) : provenance.source, params.city === "hcmc" && hcmcNote]
    .filter(Boolean)
    .join(" · ");
  const selected = districts.find((d) => d.id === selectedId) || null;
  const plate = CITY_PLATES[params.city] || null;
  const participantsText =
    participants > 0
      ? participants === 1
        ? t("xr_participants_one")
        : t("xr_participants").replace("{n}", participants.toLocaleString(locale))
      : "";
  const cityName = cityScene?.city?.name || (params.city === "hcmc" ? "Ho Chi Minh City" : "Jakarta");
  // A linked venue carries only coordinates; name it from the scene's (or the twin's) venue list.
  const venueName =
    venue.name ||
    twinVenues(params.city, cityScene?.venues).find(
      (v) => Math.abs(v.lat - venue.lat) < VENUE_MATCH_DEG && Math.abs(v.lng - venue.lng) < VENUE_MATCH_DEG,
    )?.name;
  const eventLabel = venueName ? `${t("xr_event")} · ${venueName}` : t("xr_event");
  const shareUrl = sessionCode
    ? `${window.location.origin}/xr?session=${sessionCode}&city=${params.city}`
    : "";
  // What Ask Pythia put on the table, read back from the table's own scenario, and
  // the steps the tool ran ("Local parser (no LLM) → twin forecast → queue sim").
  const askScenario = ask.result?.scenario;
  // Data honesty: where the selected day's rain comes from (scene.weather): the
  // what-if, the Open-Meteo forecast (never observed weather) or assumed dry.
  const weather = cityScene?.weather;
  const weatherDay = weather?.days?.[day] || null;
  const weatherKey = !weatherDay
    ? null
    : weatherDay.input === "scenario"
      ? "twin_rain_label"
      : weatherDay.input === "forecast"
        ? Number(weatherDay.rainfall_mm) > 0
          ? "twin_rain_forecast_label"
          : "twin_rain_forecast_dry_label"
        : weather.class === "UNAVAILABLE"
          ? weather.source === "not_applicable"
            ? "twin_rain_demo_city_label"
            : "twin_rain_unavailable_label"
          : null;
  const weatherMm = Number(weatherDay?.rainfall_mm || 0).toLocaleString(locale);
  // The one-line header's weather chip: where the day's rain comes from.
  const weatherChip = !weatherDay
    ? null
    : weatherDay.input === "scenario"
      ? t("xl_wx_whatif").replace("{n}", weatherMm)
      : weatherDay.input === "forecast"
        ? t("xl_wx_forecast").replace("{n}", weatherMm)
        : t("xl_wx_dry");
  // When the Open-Meteo forecast was fetched (local time), on forecast days.
  const fetchedAt = weather?.fetched_at ? new Date(weather.fetched_at) : null;
  const fetchedText =
    weatherDay?.input === "forecast" && fetchedAt && !Number.isNaN(fetchedAt.getTime())
      ? t("xl_fetched").replace(
          "{time}",
          fetchedAt.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }),
        )
      : null;
  const rainResponse = rainResponseText(t, weather, (n) => n.toLocaleString(locale));
  // A dry day still carries the previous days' forecast rain in its 3-day sum.
  const carriedMm = carriedRainMm(weather, day);
  const weatherText =
    [
      weatherKey ? t(weatherKey).replace("{n}", weatherMm) : null,
      fetchedText,
      rainHeldText(t, weather, day, (n) => n.toLocaleString(locale)),
      carriedMm === null ? null : t("ufx_twin_rain_carry").replace("{n}", carriedMm.toLocaleString(locale)),
    ]
      .filter(Boolean)
      .join(" · ") || null;
  const appliedText = [
    `${scenario.rain.toLocaleString(locale)} mm`,
    scenario.eventPreset !== "none" &&
      [t(`xr_event_${scenario.eventPreset}`), venueName].filter(Boolean).join(" · "),
    dateLabel(dates[day]),
  ]
    .filter(Boolean)
    .join(" · ");
  const askNotes = [
    askScenario?.attendance_assumed && t("xr3_ask_assumed"),
    askScenario?.snapped_to_twin_presets && t("xr3_ask_snapped"),
  ].filter(Boolean);
  const askTrace = traceKeys(ask.result?.trace)
    .map((key) => t(key))
    .join(" → ");
  const askLine = ask.status === "applied" && askTrace ? `${t("xr3_ask_title")}: ${askTrace}` : null;

  // X4: three numbers on the table, the twin briefing's own (tonnes and trucks are the
  // scene's model output for the selected day; the queue its simulated day mean).
  // On today, a briefing scenario puts today's canonical baseline under each.
  const sceneClass = cityScene?.provenance?.districts?.class || "MODEL_OUTPUT";
  const beforeCol =
    scenario.scenarioId && day === 0 && briefing?.scenario?.id === scenario.scenarioId
      ? briefing.before
      : null;
  const numbers = [
    {
      key: "tons",
      label: t("dr_row_tons"),
      value: tonnes(totalToday),
      before: beforeCol && finiteNumber(beforeCol.total_tonnage_t) ? tonnes(beforeCol.total_tonnage_t) : null,
      cls: sceneClass,
    },
    {
      key: "trucks",
      label: t("dr_row_trucks"),
      value: trucksNeeded.toLocaleString(locale),
      before:
        beforeCol && finiteNumber(beforeCol.trucks_needed)
          ? beforeCol.trucks_needed.toLocaleString(locale)
          : null,
      cls: sceneClass,
    },
    {
      key: "queue",
      label: t("dr_row_queue"),
      // A briefing scenario prints the briefing's own queue (a closed lane only exists there).
      value:
        beforeCol && finiteNumber(briefing.after?.queue_minutes_per_truck)
          ? minutes(briefing.after.queue_minutes_per_truck)
          : queue && finiteNumber(queue.baseline_mean)
            ? minutes(queue.baseline_mean)
            : "—",
      before:
        beforeCol && finiteNumber(beforeCol.queue_minutes_per_truck)
          ? minutes(beforeCol.queue_minutes_per_truck)
          : null,
      // The queue metric describes the day the scene was computed for (gsc M5).
      note:
        beforeCol && twinScenario(scenario.scenarioId)?.lanes
          ? t("dr_lanes_assumption")
              .replace("{closed}", WEIGHBRIDGE_LANES - twinScenario(scenario.scenarioId).lanes)
              .replace("{total}", WEIGHBRIDGE_LANES)
          : queue && queueDay !== day
            ? dateLabel(dates[queueDay])
            : null,
      cls: queue?.classification || "SIMULATED",
    },
  ];
  // X1: why there is no "place on the table" button, and which mode runs instead.
  const capability =
    mode !== "orbit"
      ? null
      : window.isSecureContext === false
        ? "insecure"
        : IS_ANDROID
          ? "no-arcore"
          : "no-webxr";
  const capabilityText = capability
    ? {
        why: t(
          capability === "insecure"
            ? "dr_xr_cap_insecure"
            : capability === "no-arcore"
              ? "xl_no_arcore"
              : "dr_xr_cap_no_webxr",
        ),
        mode: t(lite ? "dr_xr_cap_mode_lite" : "dr_xr_cap_mode_3d"),
        // The ARCore line already says how to turn the 3D table.
        hint: capability !== "no-arcore" ? t("xr3_orbit_hint") : null,
      }
    : null;
  // X1: back to the twin on the same city, day and scenario.
  const venueKey =
    scenario.venueId ||
    TWIN_VENUES[params.city]?.find(
      (v) => Math.abs(v.lat - venue.lat) < VENUE_MATCH_DEG && Math.abs(v.lng - venue.lng) < VENUE_MATCH_DEG,
    )?.id;
  const backHref = twinHref({
    city: params.city,
    day,
    rain: scenario.rain,
    event: scenario.eventPreset,
    venue: venueKey,
    scenarioDay: scenario.scenarioDay,
    scenario: scenario.scenarioId,
  });

  // In-scene panel content; redrawn only when its text changes.
  const panelSpec = cityScene
    ? {
        lines: [
          `${t("xr_metric_total")} ${tonnes(totalToday)} · ${extraLabel} ${t("xr_metric_extra")}`,
          fleetText,
          queueLabel && `${t("xr_metric_queue")} ${queueLabel}`,
          weatherText,
          askLine,
          sessionCode
            ? [scenario.agreed ? t("xr_agreed") : `${t("xr_session_code")} ${sessionCode}`, participantsText]
                .filter(Boolean)
                .join(" · ")
            : scenario.agreed
              ? t("xr_agreed")
              : `${labelCity} · ${labelClass}`,
        ],
        // Always on the panel, whatever the session shows above: what the data is
        // and whose imagery the plate is.
        footer: [
          `${labelCity} · ${labelClass} — ${labelNote}`,
          ...(plate ? imageryCreditLines(t("xr_imagery")) : []),
        ],
        rows: [
          {
            label: t("xr_rain"),
            buttons: RAIN_PRESETS.map((mm) => ({
              id: `rain:${mm}`,
              label: `${mm} mm`,
              active: scenario.rain === mm,
            })),
          },
          {
            label: t("xr_event"),
            buttons: EVENT_PRESETS.map((p) => ({
              id: `event:${p.id}`,
              label: t(`xr_event_${p.id}`),
              active: scenario.eventPreset === p.id,
            })),
          },
          {
            label: t("xr_day"),
            buttons: [
              { id: "day-prev", label: "‹", disabled: day === 0 },
              { id: "day-label", label: dateLabel(dates[day]), disabled: true },
              { id: "day-next", label: "›", disabled: day >= dayCount - 1 },
              { id: "agree", label: t("xr_agree"), active: scenario.agreed },
            ],
          },
        ],
      }
    : null;
  const panelKey = panelSpec ? JSON.stringify(panelSpec) : "";
  useEffect(() => {
    if (engineState.ready && panelKey) engineRef.current?.setPanel(JSON.parse(panelKey));
  }, [engineState.ready, panelKey]);

  useEffect(() => {
    window.__pythiaXr = {
      ready: engineState.ready,
      mode,
      session,
      bars: engineState.bars,
      city: params.city,
      selectedDay: day,
      date: cityScene?.horizon?.dates?.[day] || null,
      sceneLabel: engineRef.current?.labelText?.() || null,
      rainfall_mm: scenario.rain,
      eventPreset: scenario.eventPreset,
      agreed: scenario.agreed,
      sessionCode,
      sceneRainfall: cityScene?.scenario?.rainfall_mm ?? null,
      sceneLoading,
      selectedId,
      venueId: scenario.venueId,
      scenarioDay: scenario.scenarioDay,
      participants,
      lite,
      liteSource: liteState.source,
      liteReasons: liteState.reasons,
      // Live engine stats (the plate texture loads after the first frame).
      get rainParticles() {
        return engineRef.current?.stats().rainParticles ?? 0;
      },
      get flowCount() {
        return engineRef.current?.stats().flowCount ?? 0;
      },
      get districtShape() {
        return engineRef.current?.stats().districtShape ?? null;
      },
      get highlightId() {
        return engineRef.current?.stats().highlightId ?? null;
      },
      get plate() {
        return engineRef.current?.stats().plate ?? "none";
      },
      get flowArcs() {
        return engineRef.current?.stats().flowArcs ?? [];
      },
      get arcSegments() {
        return engineRef.current?.stats().arcSegments ?? 0;
      },
      get districtVertices() {
        return engineRef.current?.stats().districtVertices ?? 0;
      },
      get pixelRatio() {
        return engineRef.current?.stats().pixelRatio ?? null;
      },
      get antialias() {
        return engineRef.current?.stats().antialias ?? null;
      },
      get shadows() {
        return engineRef.current?.stats().shadows ?? null;
      },
      get panelText() {
        return engineRef.current?.panelText() || "";
      },
      screenPoint: (id) => engineRef.current?.screenPoint(id) ?? null,
    };
  }, [
    engineState,
    mode,
    session,
    params.city,
    day,
    cityScene,
    labelClass,
    labelNote,
    scenario,
    sessionCode,
    sceneLoading,
    selectedId,
    participants,
    lite,
    liteState,
  ]);

  useEffect(
    () => () => {
      delete window.__pythiaXr;
    },
    [],
  );

  return (
    <main
      className={`xr-shell${session ? " in-session" : ""}`}
      data-testid="xr-tabletop"
      data-mode={mode}
      data-session={session || "none"}
    >
      <div
        className="xr-canvas"
        ref={mountRef}
        role="img"
        aria-label={t("xr_canvas_label").replace("{city}", cityName)}
      />

      <div className="xr-overlay" ref={overlayRef}>
        <header className={`xr-panel xr-head${headOpen ? " open" : ""}`} ref={headRef} data-testid="xr-head">
          {/* One line on a phone: city · date · total · provenance, with a chevron for the rest. */}
          <div className="xr-head-row">
            <a
              className="xr-back"
              href={backHref}
              data-testid="xr-back"
              aria-label={t("dr_xr_back_label")}
              title={t("dr_xr_back_label")}
            >
              <ChevronLeft size={18} aria-hidden="true" />
              <span>{t("dr_xr_back")}</span>
            </a>
            <div className="xr-head-title">
              <h1>{cityName}</h1>
              {cityScene && (
                <span className="xr-head-sum" data-testid="xr-head-summary">
                  <span className="xr-head-sum-main">
                    {dateLabel(dates[day])} · {tonnes(totalToday)}
                  </span>
                  {weatherChip && (
                    <span className="xr-head-wx" data-testid="xr-head-weather" data-input={weatherDay.input}>
                      {weatherChip}
                    </span>
                  )}
                </span>
              )}
            </div>
            {cityScene && (
              <span
                className={`xr-prov ${provenance.class === "SIMULATED_DEMO_CITY" ? "demo" : "model"}`}
                data-testid="xr-provenance"
                data-class={provenance.class || ""}
              >
                {provLabelKey ? t(provLabelKey) : provenance.class}
              </span>
            )}
            <button
              type="button"
              className="xr-icon-btn xr-head-toggle"
              data-testid="xr-head-toggle"
              aria-expanded={headOpen}
              aria-controls="xr-head-detail"
              aria-label={headOpen ? t("xr3_head_less") : t("xr3_head_more")}
              title={headOpen ? t("xr3_head_less") : t("xr3_head_more")}
              onClick={() => setHeadOpen((open) => !open)}
            >
              {headOpen ? (
                <ChevronUp size={18} aria-hidden="true" />
              ) : (
                <ChevronDown size={18} aria-hidden="true" />
              )}
            </button>
          </div>

          <div className="xr-head-detail" id="xr-head-detail" hidden={!headOpen}>
            <div className="xr-head-meta">
              <span className="xr-kicker">
                <Box size={13} aria-hidden="true" /> {t("xr_kicker")}
              </span>
              <div className="xr-lang" role="group" aria-label={t("xr_language")}>
                {["id", "en"].map((code) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={lang === code}
                    className={lang === code ? "active" : ""}
                    onClick={() => setLang(code)}
                  >
                    {code.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            {cityScene && (
              <>
                {sessionCode && participantsText && (
                  <p className="xr-presence" data-testid="xr-participants" data-count={participants}>
                    <Users size={14} aria-hidden="true" /> {participantsText}
                  </p>
                )}
                {(cityScene.scenario?.rainfall_mm > 0 || cityScene.scenario?.event_attendance > 0) && (
                  <p className="xr-scenario" data-testid="xr-scenario">
                    {/* No crowd, no event clause (never "event 0 people"). */}
                    {t(cityScene.scenario.event_attendance > 0 ? "xr_scenario" : "xl_scenario_rain")
                      .replace("{rain}", Number(cityScene.scenario.rainfall_mm || 0).toLocaleString(locale))
                      .replace(
                        "{people}",
                        Number(cityScene.scenario.event_attendance || 0).toLocaleString(locale),
                      )}
                    {/* The what-if holds for one day only (gsc-2026 #5): name it. */}
                    {` · ${dateLabel(dates[finiteNumber(cityScene.scenario.scenario_day) ? cityScene.scenario.scenario_day : scenario.scenarioDay])}`}
                  </p>
                )}
                {weatherText && (
                  <p className="xr-weather" data-testid="xr-weather" data-input={weatherDay.input}>
                    {weatherText}
                  </p>
                )}
                {scenario.scenarioId && (
                  <p className="xr-briefing-name" data-testid="xr-briefing-name">
                    {t("dr_xr_on_table").replace("{name}", t(`dr_scn_${scenario.scenarioId}`))}
                  </p>
                )}
                <dl className="xr-numbers" data-testid="xr-numbers" aria-busy={sceneLoading}>
                  {numbers.map((n) => (
                    <div key={n.key} data-metric={n.key}>
                      <dt>
                        {n.label}
                        <small>{t(`twin_class_${n.cls}`)}</small>
                      </dt>
                      <dd data-testid={`xr-num-${n.key}`}>{n.value}</dd>
                      {n.before && (
                        <dd className="xr-number-before" data-testid={`xr-num-${n.key}-before`}>
                          {t("dr_xr_today").replace("{n}", n.before)}
                        </dd>
                      )}
                      {n.note && <dd className="xr-number-before">{n.note}</dd>}
                    </div>
                  ))}
                </dl>
                {/* X4: everything behind the three numbers, one tap away. */}
                <details className="xr-method" data-testid="xr-method">
                  <summary>{t("dr_method")}</summary>
                  <p className="xr-prov-note" data-testid="xr-provenance-note">
                    {provNote}
                  </p>
                  {rainResponse && (
                    <p className="xr-weather" data-testid="xr-rain-response">
                      {rainResponse}
                    </p>
                  )}
                  <dl className="xr-metrics" data-testid="xr-readout" aria-busy={sceneLoading}>
                    <div>
                      <dt>{t("xr_metric_date")}</dt>
                      <dd data-testid="xr-date">{dateLabel(dates[day])}</dd>
                    </div>
                    <div>
                      <dt>{t("xr_metric_total")}</dt>
                      <dd data-testid="xr-total">{tonnes(totalToday)}</dd>
                    </div>
                    <div>
                      <dt>{t("xr_metric_risk")}</dt>
                      <dd>
                        {t("xr_risk_count").replace("{n}", atRisk).replace("{total}", districts.length)}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("xr_metric_extra")}</dt>
                      <dd data-testid="xr-extra">{extraLabel}</dd>
                    </div>
                    <div>
                      <dt
                        title={[cityScene.units?.trucks_required, crewsNeeded === null && t("xr_fleet_note")]
                          .filter(Boolean)
                          .join("; ")}
                      >
                        {crewsNeeded === null ? t("xr_metric_fleet") : t("xr_metric_trucks")}
                      </dt>
                      <dd data-testid="xr-fleet">{trucksNeeded.toLocaleString(locale)}</dd>
                    </div>
                    {crewsNeeded !== null && (
                      <div>
                        <dt title={cityScene.units?.crews_required || undefined}>{t("xr_metric_crews")}</dt>
                        <dd data-testid="xr-crews">{crewsNeeded.toLocaleString(locale)}</dd>
                        {crewRule && (
                          <dd className="xr-metric-note" data-testid="xr-crew-rule">
                            {crewRule}
                          </dd>
                        )}
                      </div>
                    )}
                    {queueLabel && (
                      <div className="xr-metric-wide xr-queue-cell">
                        <dt title={t("xr_queue_note")}>
                          {t("xr_metric_queue")} ·{" "}
                          <span data-testid="xr-queue-day">{dateLabel(dates[queueDay])}</span>
                        </dt>
                        <dd data-testid="xr-queue">{queueLabel}</dd>
                        {queuePeak && (
                          <dd className="xr-metric-note" data-testid="xr-queue-peak">
                            {queuePeak}
                          </dd>
                        )}
                        {queueBand && (
                          <dd className="xr-metric-note" data-testid="xr-queue-band">
                            {queueBand}
                          </dd>
                        )}
                        {queueNormal && (
                          <dd className="xr-metric-note" data-testid="xr-queue-normal">
                            {queueNormal}
                          </dd>
                        )}
                        {queueTrips && (
                          <dd className="xr-metric-note" data-testid="xr-queue-trips">
                            {queueTrips}
                          </dd>
                        )}
                      </div>
                    )}
                  </dl>
                </details>
              </>
            )}
            <nav className="xr-cities" aria-label={t("xr_city_switch")}>
              {[
                ["jakarta", "Jakarta"],
                ["hcmc", "Ho Chi Minh City"],
              ].map(([id, name]) => (
                <a
                  key={id}
                  href={`/xr?city=${id}`}
                  aria-current={params.city === id ? "page" : undefined}
                  className={params.city === id ? "active" : ""}
                >
                  {name}
                </a>
              ))}
            </nav>
          </div>
        </header>

        {!cityScene && !loadError && (
          <p className="xr-panel xr-status" role="status">
            {t("xr_loading")}
          </p>
        )}
        {loadError && (
          <div className="xr-panel xr-status" role="alert">
            <p>{t("xr_load_failed")}</p>
            <button
              type="button"
              className="xr-btn secondary"
              onClick={() => {
                setLoadError(false);
                setAttempt((n) => n + 1);
              }}
            >
              {t("xr_retry")}
            </button>
          </div>
        )}
        {engineState.error && (
          <p className="xr-panel xr-status" role="alert">
            {t("xr_webgl_failed")}
          </p>
        )}

        <div className="xr-spacer" />

        {selected && (
          <div className="xr-panel xr-selected" data-testid="xr-selected" role="status">
            <div>
              <strong>{selected.name}</strong>
              <span>
                {tonnes(dayTons(selected, day))} · {t(`xr_risk_${dayRisk(selected, day)}`)}
              </span>
            </div>
            <button
              type="button"
              className="xr-icon-btn"
              aria-label={t("xr_close")}
              onClick={() => changeScenario({ selectedId: null })}
            >
              <X size={18} />
            </button>
          </div>
        )}

        {cityScene && (
          <section
            className={`xr-panel xr-controls${scenarioOpen ? " open" : ""}`}
            ref={controlsRef}
            data-testid="xr-controls"
            aria-label={t("xr_controls")}
          >
            {session === "immersive-ar" && (
              <>
                <p className="xr-hint" role="status" data-testid="xr-ar-hint">
                  {arStage === "placed"
                    ? t("xr3_ar_placed")
                    : arStage === "ready"
                      ? t("xr_ar_tap")
                      : t("xr_ar_scan")}
                </p>
                <div className="xr-tool-row">
                  <button
                    type="button"
                    className="xr-icon-btn"
                    aria-label={t("xr_rotate_left")}
                    onClick={() => engineRef.current?.rotate(-15)}
                  >
                    <RotateCcw size={18} />
                  </button>
                  <button
                    type="button"
                    className="xr-icon-btn"
                    aria-label={t("xr_rotate_right")}
                    onClick={() => engineRef.current?.rotate(15)}
                  >
                    <RotateCw size={18} />
                  </button>
                  <button
                    type="button"
                    className="xr-icon-btn"
                    aria-label={t("xr_smaller")}
                    onClick={() => engineRef.current?.scale(0.8)}
                  >
                    <Minus size={18} />
                  </button>
                  <button
                    type="button"
                    className="xr-icon-btn"
                    aria-label={t("xr_larger")}
                    onClick={() => engineRef.current?.scale(1.25)}
                  >
                    <Plus size={18} />
                  </button>
                  <button
                    type="button"
                    className="xr-icon-btn"
                    aria-label={t("xr_move")}
                    onClick={() => engineRef.current?.replace()}
                  >
                    <Move size={18} />
                  </button>
                  <button
                    type="button"
                    className="xr-icon-btn"
                    aria-label={t("xr_exit")}
                    onClick={() => engineRef.current?.endSession()}
                  >
                    <LogOut size={18} />
                  </button>
                </div>
              </>
            )}

            {!session && (
              <div className="xr-mode-row">
                {mode === "ar" && (
                  <button
                    type="button"
                    className="xr-btn primary"
                    data-testid="xr-enter-ar"
                    onClick={enterAr}
                    disabled={!engineState.ready}
                  >
                    <Box size={18} /> {t("xr_place_ar")}
                  </button>
                )}
                {mode === "vr" && (
                  <button
                    type="button"
                    className="xr-btn primary"
                    data-testid="xr-enter-vr"
                    onClick={enterVr}
                    disabled={!engineState.ready}
                  >
                    <Glasses size={18} /> {t("xr_enter_vr")}
                  </button>
                )}
                {capabilityText && (
                  // X1: a first-class 3D table, never a dead end: why AR is off and what runs.
                  <p
                    className="xr-capability"
                    role="note"
                    data-testid="xr-orbit-hint"
                    data-reason={capability}
                    data-mode={lite ? "lite" : "3d"}
                  >
                    <Info size={16} aria-hidden="true" />
                    <span>
                      {capabilityText.why} {capabilityText.mode}
                      {capabilityText.hint && <span className="xr-cap-hint"> {capabilityText.hint}</span>}
                    </span>
                  </p>
                )}
                {lite && (
                  <span className="xr-lite-tag" data-testid="xr-lite-label" title={t("xl_lite_hint")}>
                    <Gauge size={14} aria-hidden="true" /> {t("xl_lite")}
                  </span>
                )}
              </div>
            )}
            {xrError && (
              <p className="xr-error" role="alert">
                {xrError}
              </p>
            )}

            <form
              className="xr-ask"
              data-testid="xr-ask"
              onSubmit={(event) => {
                event.preventDefault();
                askPythia();
              }}
            >
              <label className="xr-visually-hidden" htmlFor="xr-ask-input">
                {t("xr3_ask_label")}
              </label>
              <Sparkles size={16} className="xr-ask-icon" aria-hidden="true" />
              <input
                id="xr-ask-input"
                data-testid="xr-ask-input"
                type="text"
                enterKeyHint="send"
                autoComplete="off"
                maxLength={500}
                value={question}
                placeholder={voice.listening ? t("asst_voice_listening") : t("xl_ask_placeholder")}
                onChange={(event) => setQuestion(event.target.value)}
              />
              {voice.supported && (
                <button
                  type="button"
                  className="xr-icon-btn"
                  data-testid="xr-ask-voice"
                  aria-pressed={voice.listening}
                  aria-label={voice.listening ? t("asst_voice_stop") : t("asst_voice_start")}
                  title={voice.listening ? t("asst_voice_stop") : t("asst_voice_start")}
                  onClick={voice.toggle}
                >
                  {voice.listening ? (
                    <MicOff size={18} aria-hidden="true" />
                  ) : (
                    <Mic size={18} aria-hidden="true" />
                  )}
                </button>
              )}
              <button
                type="submit"
                className="xr-icon-btn primary"
                data-testid="xr-ask-send"
                aria-label={t("xr3_ask_send")}
                title={t("xr3_ask_send")}
                aria-busy={ask.status === "loading"}
                disabled={ask.status === "loading"}
              >
                <Send size={18} aria-hidden="true" />
              </button>
            </form>
            {ask.status !== "idle" && (
              <div
                className="xr-ask-result"
                aria-live="polite"
                data-testid="xr-ask-result"
                data-status={ask.status}
              >
                <div className="xr-ask-text">
                  {ask.status === "loading" && <p className="xr-hint">{t("xr3_ask_loading")}</p>}
                  {ask.status === "applied" && (
                    <>
                      <p className="xr-ask-applied" data-testid="xr-ask-applied">
                        {t("xr3_ask_applied").replace("{scenario}", appliedText)}
                        {askNotes.length ? ` (${askNotes.join(", ")})` : ""}
                      </p>
                      {askTrace && (
                        <p className="xr-ask-trace" data-testid="xr-ask-trace">
                          {t("xr3_trace_label")}: {askTrace}
                        </p>
                      )}
                      {sessionCode && (
                        <p className="xr-ask-trace">{t("xr3_ask_shared").replace("{code}", sessionCode)}</p>
                      )}
                    </>
                  )}
                  {ask.status === "none" && <p className="xr-hint">{t("xr3_ask_none")}</p>}
                  {ask.status === "error" && <p className="xr-error">{t("xr3_ask_error")}</p>}
                  {ask.status === "other-city" && (
                    <p className="xr-hint">
                      {t("xr3_ask_other_city").replace(
                        "{city}",
                        ask.result.otherCity === "hcmc" ? "Ho Chi Minh City" : "Jakarta",
                      )}{" "}
                      <a className="xr-ask-link" href={`/xr?city=${ask.result.otherCity}`}>
                        {t("xr3_ask_open_city").replace(
                          "{city}",
                          ask.result.otherCity === "hcmc" ? "Ho Chi Minh City" : "Jakarta",
                        )}
                      </a>
                    </p>
                  )}
                </div>
                {ask.status !== "loading" && (
                  <button
                    type="button"
                    className="xr-icon-btn"
                    aria-label={t("xr_close")}
                    onClick={() => setAsk({ status: "idle", asked: "", result: null })}
                  >
                    <X size={18} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            <div className="xr-scrubber">
              <button
                type="button"
                className="xr-icon-btn"
                data-testid="xr-day-prev"
                aria-label={t("xr_day_prev")}
                onClick={() => stepDay(-1)}
                disabled={day === 0}
              >
                <ChevronLeft size={20} />
              </button>
              <label className="xr-range">
                <span className="xr-visually-hidden">{t("xr_day_label")}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, dayCount - 1)}
                  step={1}
                  value={day}
                  data-testid="xr-day-scrubber"
                  aria-valuetext={[
                    dateLabel(dates[day]),
                    t("ufx_twin_day_at_risk").replace("{n}", String(weekRisk[day]?.count ?? 0)),
                  ].join(" · ")}
                  onChange={(e) => changeScenario({ day: Number(e.target.value) })}
                />
                <span className="xr-range-ticks" aria-hidden="true">
                  {dates.map((iso, i) => (
                    <span
                      key={iso}
                      className={i === day ? "active" : ""}
                      data-at-risk={weekRisk[i]?.count ?? 0}
                    >
                      {Number(iso.slice(8, 10))}
                      {weekRisk[i]?.count > 0 && (
                        <b className="xr-tick-risk" data-level={weekRisk[i].worst}>
                          {weekRisk[i].count}
                        </b>
                      )}
                    </span>
                  ))}
                </span>
              </label>
              <button
                type="button"
                className="xr-icon-btn"
                data-testid="xr-day-next"
                aria-label={t("xr_day_next")}
                onClick={() => stepDay(1)}
                disabled={day >= dayCount - 1}
              >
                <ChevronRight size={20} />
              </button>
            </div>

            <button
              type="button"
              className="xr-btn secondary xr-scenario-toggle"
              data-testid="xr-scenario-toggle"
              aria-expanded={scenarioOpen}
              aria-controls="xr-scenario-panel"
              onClick={() => setScenarioOpen((open) => !open)}
            >
              <SlidersHorizontal size={18} aria-hidden="true" />
              <span className="xr-toggle-title">{t("xr_scenario_toggle")}</span>
              <span className="xr-toggle-summary">
                {scenario.scenarioId
                  ? t(`dr_scn_${scenario.scenarioId}`)
                  : `${scenario.rain.toLocaleString(locale)} mm · ${t(`xr_event_${scenario.eventPreset}`)}`}
                {sessionCode ? ` · ${sessionCode}` : ""}
              </span>
              {scenarioOpen ? (
                <ChevronUp size={18} aria-hidden="true" />
              ) : (
                <ChevronDown size={18} aria-hidden="true" />
              )}
            </button>
            {sceneLoading && (
              <p className="xr-hint" role="status" data-testid="xr-updating">
                {t("xr_updating")}
              </p>
            )}
            {scenarioOpen && (
              <div className="xr-scenario-panel" id="xr-scenario-panel">
                <div className="xr-scenario-controls" data-testid="xr-scenario-controls">
                  {params.city === "jakarta" && (
                    <div className="xr-chip-group" role="group" aria-label={t("dr_title")}>
                      <span className="xr-chip-label" aria-hidden="true">
                        {t("dr_title")}
                      </span>
                      <div className="xr-chips">
                        {TWIN_SCENARIOS.map(({ id }) => (
                          <button
                            key={id}
                            type="button"
                            className="xr-chip"
                            data-testid={`xr-scenario-${id}`}
                            aria-pressed={scenario.scenarioId === id}
                            onClick={() => chooseScenario(id)}
                          >
                            {t(`dr_scn_${id}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="xr-chip-group" role="group" aria-label={t("xr_rain")}>
                    <span className="xr-chip-label" aria-hidden="true">
                      {t("xr_rain")}
                    </span>
                    <div className="xr-chips">
                      {RAIN_PRESETS.map((mm) => (
                        <button
                          key={mm}
                          type="button"
                          className="xr-chip"
                          data-testid={`xr-rain-${mm}`}
                          aria-pressed={scenario.rain === mm}
                          onClick={() => changeScenario((prev) => ({ rain: mm, scenarioDay: prev.day }))}
                        >
                          {mm} mm
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="xr-chip-group" role="group" aria-label={eventLabel}>
                    <span className="xr-chip-label" aria-hidden="true">
                      {eventLabel}
                    </span>
                    <div className="xr-chips">
                      {EVENT_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className="xr-chip"
                          data-testid={`xr-event-${preset.id}`}
                          aria-pressed={scenario.eventPreset === preset.id}
                          onClick={() =>
                            changeScenario((prev) => ({ eventPreset: preset.id, scenarioDay: prev.day }))
                          }
                        >
                          {t(`xr_event_${preset.id}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="xr-session-row">
                  <button
                    type="button"
                    className={`xr-btn ${scenario.agreed ? "primary" : "secondary"}`}
                    data-testid="xr-agree"
                    aria-pressed={scenario.agreed}
                    onClick={toggleAgree}
                  >
                    <Check size={18} aria-hidden="true" /> {t("xr_agree")}
                  </button>
                  {!sessionCode && (
                    <button
                      type="button"
                      className="xr-btn secondary"
                      data-testid="xr-share"
                      onClick={() => share()}
                      disabled={sharing}
                    >
                      <Share2 size={18} aria-hidden="true" /> {t("xr_share")}
                    </button>
                  )}
                </div>
                {sessionCode && (
                  <div className="xr-session" data-testid="xr-session">
                    <div className="xr-session-head">
                      <span className="xr-session-label">{t("xr_session_code")}</span>
                      <strong className="xr-session-code" data-testid="xr-session-code">
                        {sessionCode}
                      </strong>
                    </div>
                    <code className="xr-session-url" data-testid="xr-session-url">
                      {shareUrl}
                    </code>
                    <button
                      type="button"
                      className="xr-btn secondary"
                      data-testid="xr-copy-link"
                      onClick={() => copyLink(shareUrl)}
                    >
                      <Copy size={18} aria-hidden="true" /> {copied ? t("xr_copied") : t("xr_copy")}
                    </button>
                    <p className="xr-session-note">{t("xr_session_note")}</p>
                  </div>
                )}
                {!session && (
                  <div className="xr-lite-row">
                    <button
                      type="button"
                      className={`xr-btn ${lite ? "primary" : "secondary"}`}
                      data-testid="xr-lite-toggle"
                      data-lite={lite ? "on" : "off"}
                      data-source={liteState.source}
                      aria-pressed={lite}
                      onClick={toggleLite}
                    >
                      <Gauge size={18} aria-hidden="true" /> {t("xl_lite")}
                    </button>
                    <p className="xr-session-note">{t("xl_lite_hint")}</p>
                  </div>
                )}
                <div className="xr-legend">
                  <ul aria-label={t("xr_legend")}>
                    {RISK_LEVELS.map((level) => (
                      <li key={level}>
                        <span
                          className="xr-swatch"
                          style={{ background: RISK_COLORS[level] }}
                          aria-hidden="true"
                        />
                        {t(`xr_risk_${level}`)}
                      </li>
                    ))}
                    <li>
                      <span className="xr-swatch landfill" aria-hidden="true" />
                      {t("xr_landfill")}
                    </li>
                  </ul>
                  <p>{t("xr_height_note")}</p>
                  <p data-testid="xr-flow-note">
                    {t("xr_flows_legend").replace("{n}", String(TRUCKS_PER_DOT))}
                    {cityScene.scenario?.rainfall_mm > 0 ? ` ${t("xr_rain_legend")}` : ""}
                  </p>
                </div>
              </div>
            )}
            {scenario.agreed && (
              <p className="xr-agreed" role="status" data-testid="xr-agreed">
                {/* X3: on a briefing scenario the agreement reaches Rencana as a session note. */}
                {t(scenario.scenarioId && params.city === "jakarta" ? "dr_xr_agreed_plan" : "xr_agreed")}
              </p>
            )}
            {sessionErrorKey && (
              <p className="xr-error" role="status" data-testid="xr-session-error">
                {t(sessionErrorKey)}
              </p>
            )}
          </section>
        )}
        {cityScene && plate && (
          <p className="xr-credit" data-testid="xr-imagery-credit">
            {t("xr_imagery")}: {IMAGERY_CREDIT}
          </p>
        )}
      </div>
    </main>
  );
}
