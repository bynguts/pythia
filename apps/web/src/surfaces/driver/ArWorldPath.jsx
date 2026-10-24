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
// Honest limits, shown in the HUD: the path is only as good as phone GPS
// (± accuracy) and the compass, never lane-level; a straight-line fallback
// says so; without floor tracking the floor height is an estimate.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ChevronLeft, ChevronRight, LocateFixed, Navigation, Route, X } from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";
import {
  CHEVRON_STEP_M,
  PATH_AHEAD_M,
  YAW_STEP_DEG,
  alongOnPolyline,
  chevronsAhead,
  enuToScene,
  legPolyline,
  nudgeYaw,
  referenceHeading,
  sceneYawForBearing,
  shouldReanchor,
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

// three.js side of the street path. `state` is a ref the React side keeps
// current; `dirty` bumps whenever chevrons, anchor or yaw change.
function startScene(session, state, { onReady, onFail, onEnded }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.xr.enabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);

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
  pin.add(pole, head);
  pin.visible = false;
  scene.add(pin);

  let disposed = false;
  let floorY = 0;
  let refHeading = null; // compass heading of the reference space's -Z
  let refSource = null; // "compass" | "guess"
  let origin = null; // scene {x, z} of the current anchor fix
  let originSeq = -1;
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
  }

  function onFrame(_time, frame) {
    if (!frame) return;
    const space = renderer.xr.getReferenceSpace();
    const pose = space ? frame.getViewerPose(space) : null;
    if (pose) {
      const s = state.current;
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
      // A new anchor fix is placed where the phone is now.
      if (s.anchorSeq !== originSeq) {
        origin = { x: pose.transform.position.x, z: pose.transform.position.z };
        originSeq = s.anchorSeq;
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
    renderer.dispose();
  };
}

export function ArWorldPath({ sessionPromise, fix, heading, leg, target, routeMode, routeReason, onExit }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState("starting");
  const [refType, setRefType] = useState(null);
  const [headingSource, setHeadingSource] = useState(null);
  const [yawOffset, setYawOffset] = useState(readYaw);
  const [anchor, setAnchor] = useState(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // Re-anchor the ENU origin on a fix that moved > 25 m or got more accurate.
  useEffect(() => {
    if (fix && shouldReanchor(anchor?.fix, fix)) {
      setAnchor((prev) => ({ fix, seq: (prev?.seq ?? 0) + 1 }));
    }
  }, [fix, anchor]);

  // The route in ENU metres around the anchor: the planned road leg when the
  // SPJ has one, else the straight line from the anchor fix to the stop.
  const path = useMemo(() => {
    if (!anchor || !target) return [];
    const points = routeMode === "route" && leg ? legPolyline(leg, target) : [anchor.fix, target];
    return points.map((p) => toEnu(anchor.fix, p));
  }, [anchor, target, leg, routeMode]);
  const along = anchor && fix ? alongOnPolyline(path, toEnu(anchor.fix, fix)) : 0;
  const chevrons = useMemo(() => chevronsAhead(path, along), [path, along]);
  const pin = anchor && target ? toEnu(anchor.fix, target) : null;

  const stateRef = useRef(null);
  const dirtyRef = useRef(0);
  dirtyRef.current += 1;
  stateRef.current = {
    chevrons,
    pin,
    anchorSeq: anchor?.seq ?? 0,
    yawOffset,
    heading: Number.isFinite(heading) ? heading : null,
    dirty: dirtyRef.current,
    onHeadingSource: setHeadingSource,
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
      data-yaw-offset={yawOffset}
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
      <p className="ar-world-line" data-testid="ar-world-accuracy">
        <LocateFixed size={14} aria-hidden="true" />{" "}
        {accuracy === null ? t("ar_world_accuracy_unknown") : t("ar_world_accuracy").replace("{n}", accuracy)}
      </p>
      {headingSource === "guess" && (
        <p className="ar-world-line is-warn" data-testid="ar-world-no-compass">
          {t("ar_world_no_compass")}
        </p>
      )}
      {refType === "local" && (
        <p className="ar-world-line" data-testid="ar-world-floor-guess">
          {t("ar_world_floor_guess")}
        </p>
      )}
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
