// GSC-2026 WS-B: /xr — the city twin as a tabletop model.
//
// Read-only and login-free. The mode follows the device's capability:
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
  ChevronLeft,
  ChevronRight,
  Glasses,
  LogOut,
  Minus,
  Move,
  Plus,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { RISK_COLORS, RISK_LEVELS, buildCityModel, dayRisk, dayTons } from "./buildCityModel.js";
import "./xr.css";

const BACKGROUND = "#e9eeeb";
const VR_ANCHOR = new THREE.Vector3(0, 1.0, -0.7);
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const city = params.get("city") === "hcmc" ? "hcmc" : "jakarta";
  const query = new URLSearchParams({ city, days: "7" });
  // Optional scenario passthrough (e.g. ?rainfall_mm=42, as the twin's
  // "Open in AR/XR" link sends it) — the API validates it.
  ["rainfall_mm", "event_attendance", "event_lat", "event_lng"].forEach((key) => {
    if (params.get(key)) query.set(key, params.get(key));
  });
  return { city, query: query.toString(), lang: params.get("lang") };
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

  // ── XR state ──
  let session = null;
  let sessionKind = null;
  let disposed = false;
  let hitTestSource = null;
  let placed = false;
  const controller = renderer.xr.getController(0);
  scene3.add(controller);
  const tempMatrix = new THREE.Matrix4();
  controller.addEventListener("select", () => {
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
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    const ray = new THREE.Ray(
      new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld),
      new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix),
    );
    pick(ray);
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

export function XrTabletop() {
  const { t, lang, setLang } = useLanguage();
  const params = useMemo(readParams, []);
  const [cityScene, setCityScene] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [day, setDay] = useState(0);
  const [mode, setMode] = useState("detecting");
  const [session, setSession] = useState(null);
  const [arStage, setArStage] = useState("scanning");
  const [selectedId, setSelectedId] = useState(null);
  const [engineState, setEngineState] = useState({ ready: false, bars: 0, error: false });
  const [xrError, setXrError] = useState("");
  const mountRef = useRef(null);
  const overlayRef = useRef(null);
  const engineRef = useRef(null);
  const dayCount = cityScene?.horizon?.dates?.length || 0;

  useEffect(() => {
    if (params.lang === "en" || params.lang === "id") setLang(params.lang);
    // Run once: the URL parameter only seeds the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    setLoadError(false);
    apiFetch(`/twin/scene?${params.query}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((body) => {
        if (alive) setCityScene(body);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [params.query, attempt]);

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

  const nextDay = useCallback(() => {
    setDay((d) => (dayCount ? (d + 1) % dayCount : d));
  }, [dayCount]);
  const nextDayRef = useRef(nextDay);
  nextDayRef.current = nextDay;

  // Engine lifecycle: one renderer per loaded scene, torn down on unmount.
  useEffect(() => {
    if (!cityScene || !mountRef.current) return undefined;
    let engine;
    let alive = true;
    try {
      engine = createEngine({
        container: mountRef.current,
        cityScene,
        dayIndex: 0,
        onSelectDistrict: (id) => setSelectedId(id),
        onArStage: (stage) => setArStage((prev) => (prev === stage ? prev : stage)),
        onSessionChange: (kind) => setSession(kind),
        onNextDay: () => nextDayRef.current(),
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
  }, [cityScene]);

  useEffect(() => {
    engineRef.current?.setDay(day);
  }, [day, engineState.ready]);

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
    };
  }, [engineState, mode, session, params.city, day, cityScene, labelClass, labelNote]);

  useEffect(
    () => () => {
      delete window.__pythiaXr;
    },
    [],
  );

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

  const locale = lang === "en" ? "en-GB" : "id-ID";
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
  const provenance = cityScene?.provenance?.districts || {};
  const [provLabelKey, provNoteKey] = PROVENANCE_KEYS[provenance.class] || [];
  const selected = districts.find((d) => d.id === selectedId) || null;
  const cityName = cityScene?.city?.name || (params.city === "hcmc" ? "Ho Chi Minh City" : "Jakarta");

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
              <dl className="xr-metrics">
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
            <button type="button" className="xr-btn secondary" onClick={() => setAttempt((n) => n + 1)}>
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
                onClick={() => setDay((d) => Math.max(0, d - 1))}
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
                  onChange={(e) => setDay(Number(e.target.value))}
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
                onClick={() => setDay((d) => Math.min(dayCount - 1, d + 1))}
                disabled={day >= dayCount - 1}
              >
                <ChevronRight size={20} />
              </button>
            </div>

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
