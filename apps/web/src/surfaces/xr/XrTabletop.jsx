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
  Glasses,
  LogOut,
  Minus,
  Move,
  Plus,
  RotateCcw,
  RotateCw,
  Share2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { RISK_COLORS, RISK_LEVELS, buildCityModel, dayRisk, dayTons } from "./buildCityModel.js";
import { PANEL_HEIGHT_M, createScenePanel } from "./scenePanel.js";
import { TWIN_EVENT_PRESETS, TWIN_VENUES, twinVenues } from "../../features/twin/twinLinks.js";
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
  return {
    city,
    lang: params.get("lang"),
    rain: rain !== null && rain >= 0 && rain <= 300 ? rain : 0,
    // The twin only links the preset sizes; anything else snaps to the nearest.
    eventPreset: attendance <= 0 ? "none" : attendance > 75000 ? "100k" : "50k",
    venue: linkedVenue || TWIN_VENUES[city][0],
    session: SESSION_CODE.test(session) ? session : null,
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
  return query.toString();
}

function makeSessionCode() {
  const bytes = new Uint8Array(6);
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
  ctx.strokeStyle = "#e85d32";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 64px 'Plus Jakarta Sans', system-ui, sans-serif";
  ctx.fillText(lines[0] || "", canvas.width / 2, lines[1] ? 72 : canvas.height / 2, canvas.width - 64);
  if (lines[1]) {
    ctx.fillStyle = "#cfe0d8";
    ctx.font = "500 40px 'Plus Jakarta Sans', system-ui, sans-serif";
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
  onSelectDistrict,
  onArStage,
  onSessionChange,
  onNextDay,
  onControl,
}) {
  const reducedMotion = prefersReducedMotion();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.xr.enabled = true;
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
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -0.5, right: 0.5, top: 0.5, bottom: -0.5, near: 0.1, far: 3 });
  sun.shadow.bias = -0.0004;
  scene3.add(sun);

  const model = buildCityModel(cityScene, { dayIndex, reducedMotion });
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

  function frameCamera() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Narrow (portrait phone) viewports need the camera further back to fit
    // the plate's width.
    // The plate is seen corner-on while it orbits, so fit its diagonal.
    const span = Math.hypot(model.footprint.width, model.footprint.depth);
    const fitDistance =
      (span * 1.12) / (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, camera.aspect));
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
  function pick(ray) {
    raycaster.ray.copy(ray);
    const hit = raycaster.intersectObjects(model.bars, false)[0];
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
    label.sprite.visible = sessionKind === "immersive-vr";
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
  let placed = false;
  const controller = renderer.xr.getController(0);
  scene3.add(controller);
  // A visible pointer ray so a headset user can aim at the panel's buttons.
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]);
  const rayMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
  const rayLine = new THREE.Line(rayGeometry, rayMaterial);
  rayLine.visible = false;
  controller.add(rayLine);
  const tempMatrix = new THREE.Matrix4();
  function controllerRay() {
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    return new THREE.Ray(
      new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld),
      new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix),
    );
  }
  function syncPanel() {
    panel.mesh.visible = sessionKind === "immersive-vr" || (sessionKind === "immersive-ar" && !domOverlay);
    rayLine.visible = sessionKind === "immersive-vr";
  }
  controller.addEventListener("select", () => {
    if (panel.mesh.visible && (sessionKind === "immersive-vr" || placed)) {
      raycaster.ray.copy(controllerRay());
      const id = panel.hit(raycaster);
      if (id) onControl(id);
      if (id !== null) return;
    }
    if (sessionKind === "immersive-vr") {
      onNextDay();
      return;
    }
    if (sessionKind !== "immersive-ar") return;
    if (!placed) {
      if (!reticle.visible) return;
      anchor.position.setFromMatrixPosition(reticle.matrix);
      anchor.visible = true;
      placed = true;
      reticle.visible = false;
      onArStage("placed");
      return;
    }
    pick(controllerRay());
  });

  function resetAnchor() {
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
    session = null;
    sessionKind = null;
    domOverlay = false;
    syncPanel();
    placed = false;
    reticle.visible = false;
    if (label) label.sprite.visible = false;
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
      const source = await next.requestHitTestSource({ space: viewerSpace });
      if (!live()) {
        source?.cancel?.();
        return;
      }
      hitTestSource = source;
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
      if (label) label.sprite.visible = true;
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
  renderer.setAnimationLoop((time, frame) => {
    const now = performance.now();
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
    setPanel: (spec) => panel.draw(spec),
    setLabel,
    labelText: () => label?.sprite.userData.text || null,
    startAr,
    startVr,
    endSession: () => session?.end(),
    rotate: (deg) => {
      anchor.rotation.y += (deg * Math.PI) / 180;
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

const PROVENANCE_KEYS = {
  MODEL_OUTPUT: ["xr_prov_model", "xr_prov_model_note"],
  SIMULATED_DEMO_CITY: ["xr_prov_demo", "xr_prov_demo_note"],
};

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

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
    day: 0,
    agreed: false,
  }));
  const [mode, setMode] = useState("detecting");
  const [session, setSession] = useState(null);
  const [arStage, setArStage] = useState("scanning");
  const [selectedId, setSelectedId] = useState(null);
  const [engineState, setEngineState] = useState({ ready: false, bars: 0, error: false });
  const [xrError, setXrError] = useState("");
  const [sessionCode, setSessionCode] = useState(params.session);
  const [sessionErrorKey, setSessionErrorKey] = useState("");
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  // Presets and sharing fold away on phones so the model stays visible.
  const [scenarioOpen, setScenarioOpen] = useState(
    () => !window.matchMedia || window.matchMedia("(min-width: 700px)").matches,
  );
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
  const query = sceneQuery(params.city, scenario, params.venue);

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
      if (!("agreed" in change) && (next.rain !== prev.rain || next.eventPreset !== prev.eventPreset)) {
        next.agreed = false;
      }
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
    async function run() {
      timer = null;
      inFlight = true;
      try {
        const res = await apiFetch(`/xr/session/${sessionCode}`, { auth: false });
        if (!alive) return;
        if (res.status === 404) {
          setSessionErrorKey("xr_session_missing");
          setSessionCode(null);
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

  const stepDay = (delta) =>
    changeScenario((prev) => ({ day: Math.min(Math.max(0, dayCount - 1), Math.max(0, prev.day + delta)) }));

  const nextDay = useCallback(() => {
    changeScenario((prev) => ({ day: dayCount ? (prev.day + 1) % dayCount : prev.day }));
  }, [changeScenario, dayCount]);
  const nextDayRef = useRef(nextDay);
  nextDayRef.current = nextDay;

  // Buttons of the in-scene panel (headset / AR without DOM overlay).
  const onControl = (id) => {
    const [kind, value] = id.split(":");
    if (kind === "rain") changeScenario({ rain: Number(value) });
    else if (kind === "event") changeScenario({ eventPreset: value });
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
        onSelectDistrict: (id) => setSelectedId(id),
        onArStage: (stage) => setArStage((prev) => (prev === stage ? prev : stage)),
        onSessionChange: (kind) => setSession(kind),
        onNextDay: () => nextDayRef.current(),
        onControl: (id) => controlRef.current(id),
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
  }, [hasScene]);

  useEffect(() => {
    if (cityScene) engineRef.current?.setScene(cityScene, day);
  }, [cityScene, day, engineState.ready]);

  // Provenance travels into the headset with the model (see makeLabelSprite).
  const labelProvenance = cityScene?.provenance?.districts || {};
  const [labelKey, labelNoteKey] = PROVENANCE_KEYS[labelProvenance.class] || [];
  const labelCity = cityScene?.city?.name || "";
  const labelClass = labelKey ? t(labelKey) : labelProvenance.class || "";
  const labelNote = labelNoteKey ? t(labelNoteKey) : labelProvenance.source || "";
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
      if (event.target instanceof Element && event.target.closest(".xr-panel, .xr-controls"))
        event.preventDefault();
    };
    el.addEventListener("beforexrselect", block);
    return () => el.removeEventListener("beforexrselect", block);
  }, []);

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
  const minutes = (n) => Math.round(n).toLocaleString(locale);
  // Scenario-scaled queue: show it next to the normal day it is compared with.
  const queueScaled =
    queue?.scenario_scaled === true &&
    finiteNumber(queue.normal_day?.baseline_mean) &&
    finiteNumber(queue.normal_day?.staggered_mean);
  const queueLabel =
    queue && finiteNumber(queue.baseline_mean) && finiteNumber(queue.staggered_mean)
      ? t(queueScaled ? "xr_queue_value_scenario" : "xr_queue_value")
          .replace("{base}", minutes(queue.baseline_mean))
          .replace("{stag}", minutes(queue.staggered_mean))
          .replace("{normal_base}", queueScaled ? minutes(queue.normal_day.baseline_mean) : "")
          .replace("{normal_stag}", queueScaled ? minutes(queue.normal_day.staggered_mean) : "")
      : null;
  const fleetText =
    crewsNeeded === null
      ? `${trucksNeeded.toLocaleString(locale)} ${t("xr_metric_fleet")}`
      : `${trucksNeeded.toLocaleString(locale)} ${t("xr_metric_trucks")} · ${crewsNeeded.toLocaleString(locale)} ${t("xr_metric_crews")}`;
  const provenance = cityScene?.provenance?.districts || {};
  const [provLabelKey, provNoteKey] = PROVENANCE_KEYS[provenance.class] || [];
  const selected = districts.find((d) => d.id === selectedId) || null;
  const cityName = cityScene?.city?.name || (params.city === "hcmc" ? "Ho Chi Minh City" : "Jakarta");
  // A linked venue carries only coordinates; name it from the scene's (or the twin's) venue list.
  const venueName =
    params.venue.name ||
    twinVenues(params.city, cityScene?.venues).find(
      (v) =>
        Math.abs(v.lat - params.venue.lat) < VENUE_MATCH_DEG &&
        Math.abs(v.lng - params.venue.lng) < VENUE_MATCH_DEG,
    )?.name;
  const eventLabel = venueName ? `${t("xr_event")} · ${venueName}` : t("xr_event");
  const shareUrl = sessionCode
    ? `${window.location.origin}/xr?session=${sessionCode}&city=${params.city}`
    : "";

  // In-scene panel content; redrawn only when its text changes.
  const panelSpec = cityScene
    ? {
        lines: [
          `${t("xr_metric_total")} ${tonnes(totalToday)} · ${extraLabel} ${t("xr_metric_extra")}`,
          [fleetText, queueLabel && `${t("xr_metric_queue")} ${queueLabel}`].filter(Boolean).join(" · "),
          scenario.agreed
            ? t("xr_agreed")
            : sessionCode
              ? `${t("xr_session_code")} ${sessionCode}`
              : `${labelCity} · ${labelClass}`,
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
        <header className="xr-panel xr-head">
          <div className="xr-head-row">
            <div className="xr-title">
              <span className="xr-kicker">
                <Box size={13} aria-hidden="true" /> {t("xr_kicker")}
              </span>
              <h1>{cityName}</h1>
            </div>
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
              <div className="xr-prov-row">
                <span
                  className={`xr-prov ${provenance.class === "SIMULATED_DEMO_CITY" ? "demo" : "model"}`}
                  data-testid="xr-provenance"
                  data-class={provenance.class || ""}
                >
                  {provLabelKey ? t(provLabelKey) : provenance.class}
                </span>
                <span className="xr-prov-note">{provNoteKey ? t(provNoteKey) : provenance.source}</span>
              </div>
              {(cityScene.scenario?.rainfall_mm > 0 || cityScene.scenario?.event_attendance > 0) && (
                <p className="xr-scenario" data-testid="xr-scenario">
                  {t("xr_scenario")
                    .replace("{rain}", Number(cityScene.scenario.rainfall_mm || 0).toLocaleString(locale))
                    .replace(
                      "{people}",
                      Number(cityScene.scenario.event_attendance || 0).toLocaleString(locale),
                    )}
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
                  <dd>{t("xr_risk_count").replace("{n}", atRisk).replace("{total}", districts.length)}</dd>
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
                  </div>
                )}
                {queueLabel && (
                  <div className={queueScaled ? "xr-metric-wide" : undefined}>
                    <dt title={t("xr_queue_note")}>
                      {t("xr_metric_queue")} ·{" "}
                      <span data-testid="xr-queue-day">{dateLabel(dates[queueDay])}</span>
                    </dt>
                    <dd data-testid="xr-queue">{queueLabel}</dd>
                  </div>
                )}
              </dl>
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
              onClick={() => setSelectedId(null)}
            >
              <X size={18} />
            </button>
          </div>
        )}

        {cityScene && (
          <section className="xr-panel xr-controls" aria-label={t("xr_controls")}>
            {session === "immersive-ar" && (
              <>
                <p className="xr-hint" role="status" data-testid="xr-ar-hint">
                  {arStage === "placed"
                    ? t("xr_ar_placed")
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

            {!session && mode === "ar" && (
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
            {!session && mode === "vr" && (
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
            {!session && mode === "orbit" && (
              <p className="xr-hint" data-testid="xr-orbit-hint">
                {t("xr_orbit_hint")}
              </p>
            )}
            {xrError && (
              <p className="xr-error" role="alert">
                {xrError}
              </p>
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
                  aria-valuetext={dateLabel(dates[day])}
                  onChange={(e) => changeScenario({ day: Number(e.target.value) })}
                />
                <span className="xr-range-ticks" aria-hidden="true">
                  {dates.map((iso, i) => (
                    <span key={iso} className={i === day ? "active" : ""}>
                      {Number(iso.slice(8, 10))}
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
                {scenario.rain.toLocaleString(locale)} mm · {t(`xr_event_${scenario.eventPreset}`)}
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
                          onClick={() => changeScenario({ rain: mm })}
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
                          onClick={() => changeScenario({ eventPreset: preset.id })}
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
              </div>
            )}
            {scenario.agreed && (
              <p className="xr-agreed" role="status" data-testid="xr-agreed">
                {t("xr_agreed")}
              </p>
            )}
            {sessionErrorKey && (
              <p className="xr-error" role="status" data-testid="xr-session-error">
                {t(sessionErrorKey)}
              </p>
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
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
