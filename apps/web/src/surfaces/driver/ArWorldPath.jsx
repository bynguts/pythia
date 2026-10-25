// WebXR street path: ground chevrons along the route to the next stop,
// anchored in the world instead of a screen-fixed arrow.
//
// ArNavigator requests the immersive-ar session inside the button's click
// (user activation) and hands the pending session in; this lazy chunk owns
// three.js. Geometry is pure (geoEnu.js): the route is projected to local ENU
// metres around an anchor GPS fix, rotated by the compass heading of the XR
// reference space (captured once, plus the driver's "Align to street"
// offset) and placed where the phone stood when that fix was taken.
//
// Anchoring (gsc #6): the anchor fix follows GPS only until a fix is good to
// ±ANCHOR_LOCK_ACCURACY_M, then locks. From there WebXR tracking carries the
// path (it is smooth over a walk, GPS is not), and each new fix only checks
// for drift: when GPS and tracking disagree by more than DRIFT_FACTOR × the
// fix accuracy, the path glides to the GPS position over CORRECTION_EASE_MS
// (a snap under reduced motion). Small GPS jitter never moves a chevron.
//
// Honest limits, shown in the HUD: the path is only as good as phone GPS
// (± accuracy) and the compass, never lane-level; a straight-line fallback
// says so; without floor tracking the floor height is an estimate.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  LocateFixed,
  Navigation,
  Route,
  X,
} from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { formatDistance } from "./arMath.js";
import { LITE_RENDER, detectLite } from "../xr/xrLite.js";
import {
  ANCHOR_LOCK_ACCURACY_M,
  CHEVRON_STEP_M,
  PATH_AHEAD_M,
  YAW_STEP_DEG,
  alongOnPolyline,
  chevronsAhead,
  correctedOrigin,
  driftExceeds,
  easeOrigin,
  enuToScene,
  legPolyline,
  nextAnchor,
  nudgeYaw,
  referenceHeading,
  sceneToEnu,
  sceneYawForBearing,
  toEnu,
  viewerYawCw,
} from "./geoEnu.js";

// The manual yaw offset lives for the browser tab session only: compass error
// changes with place and phone, so it must not follow the crew to tomorrow.
const YAW_KEY = "pythia_ar_world_yaw";
// Without local-floor the reference space starts at the phone; a phone held
// at chest height puts the street about this far below it.
const FLOOR_GUESS_M = -1.4;
const MAX_CHEVRONS = Math.ceil(PATH_AHEAD_M / CHEVRON_STEP_M) + 2;
// tokens.css --ui-forest-500 / --ui-forest-700 (three.js cannot read CSS vars).
const CHEVRON_COLOR = "#2fb36a";
const PIN_COLOR = "#16613a";
// Pin label: a fixed on-screen size (about 9 % of the view height) so
// "TPS RW 04 · 120 m" stays readable however far the pin is.
const LABEL_W = 512;
const LABEL_H = 128;
const LABEL_SCALE = 0.09;
const LABEL_FONT = '"Inter Tight", Inter, system-ui, sans-serif';

function readYaw() {
  try {
    const value = Number(window.sessionStorage.getItem(YAW_KEY));
    return Number.isFinite(value) ? nudgeYaw(value, 0) : 0;
  } catch {
    return 0;
  }
}

function writeYaw(value) {
  try {
    window.sessionStorage.setItem(YAW_KEY, String(value));
  } catch {
    // Private mode / blocked storage: the offset still applies this session.
  }
}

function chevronGeometry() {
  // A flat chevron 1.2 m wide, tip toward -Z, lying face-up on the floor.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.45);
  shape.lineTo(0.6, -0.15);
  shape.lineTo(0.6, -0.45);
  shape.lineTo(0, 0.15);
  shape.lineTo(-0.6, -0.45);
  shape.lineTo(-0.6, -0.15);
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

// Draw the pin label: white text on the pin colour, shrunk, then ellipsized to fit.
function drawLabel(ctx, text) {
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);
  ctx.fillStyle = PIN_COLOR;
  ctx.beginPath();
  ctx.roundRect(4, 4, LABEL_W - 8, LABEL_H - 8, 40);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const max = LABEL_W - 64;
  let size = 56;
  let line = text;
  ctx.font = `600 ${size}px ${LABEL_FONT}`;
  while (ctx.measureText(line).width > max && size > 32) {
    size -= 4;
    ctx.font = `600 ${size}px ${LABEL_FONT}`;
  }
  while (ctx.measureText(line).width > max && line.length > 2) line = `${line.slice(0, -2)}…`;
  ctx.fillText(line, LABEL_W / 2, LABEL_H / 2 + 2);
}

// three.js side of the street path. `state` is a ref the React side keeps
// current; `dirty` bumps whenever chevrons, anchor or yaw change.
function startScene(session, state, { onReady, onFail, onEnded }) {
  // Budget phones (xrLite.js): no antialias and a smaller XR framebuffer.
  const { lite } = detectLite();
  const renderer = new THREE.WebGLRenderer({ antialias: !lite, alpha: true });
  renderer.xr.enabled = true;
  if (lite) renderer.xr.setFramebufferScaleFactor(LITE_RENDER.xrFramebufferScale);
  const scene = new THREE.Scene();
  // Far plane past any leg a crew walks, so the pin and its label stay drawn.
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 2000);

  const chevronGeo = chevronGeometry();
  const chevronMat = new THREE.MeshBasicMaterial({
    color: CHEVRON_COLOR,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const chevrons = new THREE.InstancedMesh(chevronGeo, chevronMat, MAX_CHEVRONS);
  chevrons.count = 0;
  chevrons.frustumCulled = false;
  scene.add(chevrons);

  const pin = new THREE.Group();
  const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 3, 12);
  const poleMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = 1.5;
  const headGeo = new THREE.SphereGeometry(0.35, 20, 14);
  const headMat = new THREE.MeshBasicMaterial({ color: PIN_COLOR });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.y = 3.2;
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = LABEL_W;
  labelCanvas.height = LABEL_H;
  const labelCtx = labelCanvas.getContext("2d");
  const labelTex = new THREE.CanvasTexture(labelCanvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;
  const labelMat = new THREE.SpriteMaterial({
    map: labelTex,
    transparent: true,
    depthTest: false,
    sizeAttenuation: false,
  });
  const label = new THREE.Sprite(labelMat);
  label.scale.set((LABEL_SCALE * LABEL_W) / LABEL_H, LABEL_SCALE, 1);
  label.position.y = 4.1;
  label.renderOrder = 10;
  pin.add(pole, head, label);
  pin.visible = false;
  scene.add(pin);

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let disposed = false;
  let floorY = 0;
  let refHeading = null; // compass heading of the reference space's -Z
  let refSource = null; // "compass" | "guess"
  let origin = null; // scene {x, z} of the current anchor fix
  let originTarget = null; // where a drift correction is gliding the origin to
  let originSeq = -1;
  let fixSeen = -1;
  let labelText = null;
  let lastTime = null;
  let drawn = -1;
  const dummy = new THREE.Object3D();

  function layout() {
    const heading = refHeading + state.current.yawOffset;
    const items = state.current.chevrons.slice(0, MAX_CHEVRONS);
    items.forEach((c, i) => {
      const p = enuToScene(c, heading, origin);
      dummy.position.set(p.x, floorY + 0.02, p.z);
      dummy.rotation.set(0, sceneYawForBearing(c.bearing, heading), 0);
      dummy.updateMatrix();
      chevrons.setMatrixAt(i, dummy.matrix);
    });
    chevrons.count = items.length;
    chevrons.instanceMatrix.needsUpdate = true;
    const goal = state.current.pin;
    if (goal) {
      const p = enuToScene(goal, heading, origin);
      pin.position.set(p.x, floorY, p.z);
    }
    pin.visible = Boolean(goal);
    if (labelCtx && state.current.pinLabel !== labelText) {
      labelText = state.current.pinLabel;
      drawLabel(labelCtx, labelText);
      labelTex.needsUpdate = true;
    }
  }

  function onFrame(time, frame) {
    if (!frame) return;
    const dt = lastTime === null ? 0 : time - lastTime;
    lastTime = time;
    const space = renderer.xr.getReferenceSpace();
    const pose = space ? frame.getViewerPose(space) : null;
    if (pose) {
      const s = state.current;
      const phone = { x: pose.transform.position.x, z: pose.transform.position.z };
      const yaw = viewerYawCw(pose.transform.orientation);
      // Reference heading: the live compass when there is one (upgrading a
      // guess once it arrives), else assume the camera faced along the path.
      if (yaw !== null && (refHeading === null || (refSource === "guess" && s.heading !== null))) {
        const compass = s.heading !== null ? s.heading : s.chevrons[0]?.bearing;
        const next = referenceHeading(compass, yaw);
        if (next !== null) {
          refHeading = next;
          refSource = s.heading !== null ? "compass" : "guess";
          s.onHeadingSource(refSource);
          drawn = -1;
        }
      }
      if (s.anchorSeq !== originSeq) {
        // A new anchor fix (only before the anchor locks) is placed where
        // the phone is now.
        origin = phone;
        originTarget = null;
        originSeq = s.anchorSeq;
        fixSeen = s.fixSeq;
        drawn = -1;
      } else if (s.locked && origin && refHeading !== null && s.fixSeq !== fixSeen) {
        // Locked: a new fix only checks for drift between GPS and tracking.
        fixSeen = s.fixSeq;
        const heading = refHeading + s.yawOffset;
        if (driftExceeds(s.gps, sceneToEnu(phone, heading, origin), s.accuracy)) {
          originTarget = correctedOrigin(phone, s.gps, heading);
          s.onCorrection();
        }
      }
      if (originTarget) {
        origin = reduceMotion ? originTarget : easeOrigin(origin, originTarget, dt);
        if (origin === originTarget) originTarget = null;
        drawn = -1;
      }
      if (refHeading !== null && origin && drawn !== s.dirty) {
        layout();
        drawn = s.dirty;
      }
    }
    renderer.render(scene, camera);
  }

  const handleEnd = () => {
    if (!disposed) onEnded();
  };

  (async () => {
    let refType = "local-floor";
    try {
      await session.requestReferenceSpace("local-floor");
    } catch {
      refType = "local";
      floorY = FLOOR_GUESS_M;
    }
    if (disposed) return;
    session.addEventListener("end", handleEnd);
    renderer.xr.setReferenceSpaceType(refType);
    await renderer.xr.setSession(session);
    if (disposed) return;
    renderer.setAnimationLoop(onFrame);
    onReady({ refType, domOverlay: Boolean(session.domOverlayState) });
  })().catch((error) => {
    if (!disposed) onFail(error);
  });

  return () => {
    disposed = true;
    renderer.setAnimationLoop(null);
    session.removeEventListener("end", handleEnd);
    session.end().catch(() => {});
    chevronGeo.dispose();
    chevronMat.dispose();
    poleGeo.dispose();
    poleMat.dispose();
    headGeo.dispose();
    headMat.dispose();
    labelTex.dispose();
    labelMat.dispose();
    renderer.dispose();
  };
}

export function ArWorldPath({
  sessionPromise,
  fix,
  heading,
  leg,
  target,
  stopName,
  distance,
  arrived,
  routeMode,
  routeReason,
  onExit,
}) {
  const { t, lang } = useLanguage();
  const [status, setStatus] = useState("starting");
  const [refType, setRefType] = useState(null);
  const [headingSource, setHeadingSource] = useState(null);
  const [yawOffset, setYawOffset] = useState(readYaw);
  const [anchor, setAnchor] = useState(null);
  const [corrections, setCorrections] = useState(0);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // The anchor follows GPS until a fix is good enough, then locks (nextAnchor).
  useEffect(() => {
    setAnchor((prev) => nextAnchor(prev, fix));
  }, [fix]);

  // The route in ENU metres around the anchor: the planned road leg when the
  // SPJ has one, else the straight line from the anchor fix to the stop.
  const path = useMemo(() => {
    if (!anchor || !target) return [];
    const points = routeMode === "route" && leg ? legPolyline(leg, target) : [anchor.fix, target];
    return points.map((p) => toEnu(anchor.fix, p));
  }, [anchor, target, leg, routeMode]);
  const gps = anchor && fix ? toEnu(anchor.fix, fix) : null;
  const along = gps ? alongOnPolyline(path, gps) : 0;
  const chevrons = useMemo(() => chevronsAhead(path, along), [path, along]);
  const pin = anchor && target ? toEnu(anchor.fix, target) : null;
  const meters = Number.isFinite(distance) ? Math.round(distance) : null;
  const distanceText = meters === null ? "" : formatDistance(meters, lang);
  const pinLabel = distanceText ? `${stopName} · ${distanceText}` : stopName;

  // Each new fix gets a number, so the scene checks drift once per fix.
  const fixRef = useRef({ fix: null, seq: 0 });
  if (fixRef.current.fix !== fix) fixRef.current = { fix, seq: fixRef.current.seq + 1 };

  const stateRef = useRef(null);
  const dirtyRef = useRef(0);
  dirtyRef.current += 1;
  stateRef.current = {
    chevrons,
    pin,
    pinLabel,
    anchorSeq: anchor?.seq ?? 0,
    locked: Boolean(anchor?.locked),
    gps,
    accuracy: fix && Number.isFinite(fix.accuracy) ? fix.accuracy : null,
    fixSeq: fixRef.current.seq,
    yawOffset,
    heading: Number.isFinite(heading) ? heading : null,
    dirty: dirtyRef.current,
    onHeadingSource: setHeadingSource,
    onCorrection: () => setCorrections((n) => n + 1),
  };

  useEffect(() => {
    let stop = null;
    let cancelled = false;
    sessionPromise
      .then((session) => {
        if (cancelled) {
          session.end().catch(() => {});
          return;
        }
        stop = startScene(session, stateRef, {
          onReady: ({ refType: type }) => {
            setRefType(type);
            setStatus("live");
          },
          onFail: () => onExitRef.current("error"),
          onEnded: () => onExitRef.current("ended"),
        });
      })
      .catch(() => {
        if (!cancelled) onExitRef.current("error");
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [sessionPromise]);

  const nudge = (delta) => {
    const next = nudgeYaw(yawOffset, delta);
    setYawOffset(next);
    writeYaw(next);
  };

  const accuracy = fix && Number.isFinite(fix.accuracy) ? Math.round(fix.accuracy) : null;
  const yawText = `${yawOffset > 0 ? "+" : ""}${yawOffset}°`;

  return (
    <section
      className="ar-world-hud"
      aria-label={t("ar_world_title")}
      data-testid="ar-world-hud"
      data-status={status}
      data-ref-space={refType || ""}
      data-heading-source={headingSource || ""}
      data-route-mode={routeMode}
      data-chevrons={chevrons.length}
      data-anchors={anchor?.seq ?? 0}
      data-anchor-locked={anchor?.locked ? "true" : "false"}
      data-corrections={corrections}
      data-yaw-offset={yawOffset}
      data-meters={meters ?? ""}
      data-pin-label={pinLabel}
      data-arrived={arrived ? "true" : "false"}
    >
      <div className="ar-world-head">
        <h2>
          <Navigation size={18} aria-hidden="true" /> {t("ar_world_title")}
        </h2>
        <button
          type="button"
          className="ar-world-exit"
          data-testid="ar-world-exit"
          onClick={() => onExitRef.current("user")}
        >
          <X size={18} aria-hidden="true" /> {t("ar_world_exit")}
        </button>
      </div>
      {arrived ? (
        <div className="ar-world-arrived" role="status" data-testid="ar-world-arrived">
          <p className="ar-world-arrived-title">
            <CheckCircle2 size={22} aria-hidden="true" /> {t("ar3_arrived").replace("{name}", stopName)}
          </p>
          <button
            type="button"
            className="ar-btn primary"
            data-testid="ar-world-capture"
            onClick={() => onExitRef.current("arrived")}
          >
            <Camera size={18} aria-hidden="true" /> {t("ar3_capture")}
          </button>
          <p className="ar-world-line">{t("ar3_capture_note")}</p>
        </div>
      ) : (
        <div className="ar-world-target">
          <span className="ar-world-distance" data-testid="ar-world-distance" data-meters={meters ?? ""}>
            {distanceText || "—"}
          </span>
          <span className="ar-world-stop" data-testid="ar-world-stop">
            {t("ar3_to_stop").replace("{name}", stopName)}
          </span>
        </div>
      )}
      <p className="ar-world-status" aria-live="polite" data-testid="ar-world-status">
        {t(status === "live" ? "ar_world_live" : "ar_world_starting")}
      </p>
      <p
        className={`ar-world-line${routeMode === "route" ? "" : " is-warn"}`}
        data-testid="ar-world-route"
        data-mode={routeMode}
      >
        <Route size={14} aria-hidden="true" />{" "}
        {routeMode === "route"
          ? t("ar_world_route")
          : t("ar_world_straight").replace("{reason}", routeReason)}
      </p>
      {/* Every caveat in one chip: GPS ±, never lane-level, how the heading
          was set, and what is still estimated. */}
      <p className="ar-world-caveats" data-testid="ar-world-caveats">
        <LocateFixed size={14} aria-hidden="true" />
        <span>
          <span data-testid="ar-world-accuracy">
            {accuracy === null ? t("ar3_gps_unknown") : t("ar3_gps").replace("{n}", accuracy)}
          </span>
          {" · "}
          {t("ar3_not_lane")}
          {anchor && !anchor.locked && (
            <span className="is-warn" data-testid="ar-world-settling">
              {" · "}
              {t("ar3_settling").replace("{n}", ANCHOR_LOCK_ACCURACY_M)}
            </span>
          )}
          {headingSource === "compass" && <span>{` · ${t("ar3_heading_compass")}`}</span>}
          {headingSource === "guess" && (
            <span className="is-warn" data-testid="ar-world-no-compass">
              {` · ${t("ar3_heading_guess")}`}
            </span>
          )}
          {refType === "local" && (
            <span data-testid="ar-world-floor-guess">{` · ${t("ar3_floor_guess")}`}</span>
          )}
        </span>
      </p>
      <div className="ar-world-align" role="group" aria-label={t("ar_world_align")}>
        <button
          type="button"
          className="ar-world-nudge"
          data-testid="ar-world-yaw-left"
          aria-label={t("ar_world_align_left").replace("{n}", YAW_STEP_DEG)}
          onClick={() => nudge(-YAW_STEP_DEG)}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <span className="ar-world-align-value" data-testid="ar-world-yaw">
          {t("ar_world_align")} · {yawText}
        </span>
        <button
          type="button"
          className="ar-world-nudge"
          data-testid="ar-world-yaw-right"
          aria-label={t("ar_world_align_right").replace("{n}", YAW_STEP_DEG)}
          onClick={() => nudge(YAW_STEP_DEG)}
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
