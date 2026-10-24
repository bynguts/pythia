// In-scene scenario panel for immersive sessions without a DOM overlay (VR,
// or AR where dom-overlay was not granted). One canvas texture on one plane:
// text lines on top, then rows of large buttons. The controller ray hits the
// plane and the hit's UV picks the button, so no per-button meshes are needed.
import * as THREE from "three";

const W = 1024;
const H = 640;
const PAD = 28;
const LINE_H = 46;
const ROW_H = 96;
const ROW_GAP = 14;
const LABEL_W = 180;
const BTN_GAP = 12;
export const PANEL_WIDTH_M = 0.42;
export const PANEL_HEIGHT_M = (PANEL_WIDTH_M * H) / W;

const COLORS = {
  panel: "rgba(19, 33, 29, 0.94)",
  edge: "#2fb36a",
  text: "#ffffff",
  muted: "#cfe0d8",
  button: "#2c4038",
  buttonEdge: "#5d7a6d",
  active: "#16613a",
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/**
 * `draw({ lines, rows })`: `lines` are short strings (first one bold), `rows`
 * are `{ label, buttons: [{ id, label, active, disabled }] }`. `hit(raycaster)`
 * returns the id of the enabled button under the ray, "" for the panel's
 * background (so a near miss does nothing) and null when the ray misses it.
 */
export function createScenePanel() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
  const geometry = new THREE.PlaneGeometry(PANEL_WIDTH_M, PANEL_HEIGHT_M);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "scenario-panel";
  mesh.visible = false;
  let targets = [];

  function draw({ lines = [], rows = [] }) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COLORS.panel;
    roundRect(ctx, 4, 4, W - 8, H - 8, 28);
    ctx.fill();
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let y = PAD;
    lines.slice(0, 3).forEach((line, i) => {
      ctx.fillStyle = i === 0 ? COLORS.text : COLORS.muted;
      ctx.font = `${i === 0 ? 700 : 500} 34px 'Inter Tight', Inter, system-ui, sans-serif`;
      ctx.fillText(line, PAD, y + LINE_H / 2, W - PAD * 2);
      y += LINE_H;
    });
    y += ROW_GAP;
    targets = [];
    rows.forEach((row) => {
      ctx.fillStyle = COLORS.muted;
      ctx.font = "600 32px 'Inter Tight', Inter, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(row.label, PAD, y + ROW_H / 2, LABEL_W - 12);
      const count = row.buttons.length;
      const x0 = PAD + LABEL_W;
      const bw = (W - PAD - x0 - BTN_GAP * (count - 1)) / count;
      row.buttons.forEach((button, i) => {
        const x = x0 + i * (bw + BTN_GAP);
        if (!button.disabled || button.active) {
          ctx.fillStyle = button.active ? COLORS.active : COLORS.button;
          roundRect(ctx, x, y, bw, ROW_H, 18);
          ctx.fill();
          ctx.strokeStyle = button.active ? COLORS.active : COLORS.buttonEdge;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        ctx.fillStyle = button.disabled && !button.active ? COLORS.muted : COLORS.text;
        ctx.font = `${button.active ? 700 : 600} 34px 'Inter Tight', Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(button.label, x + bw / 2, y + ROW_H / 2, bw - 16);
        if (!button.disabled) targets.push({ id: button.id, x, y, w: bw, h: ROW_H });
      });
      y += ROW_H + ROW_GAP;
    });
    texture.needsUpdate = true;
  }

  function hit(raycaster) {
    if (!mesh.visible) return null;
    const intersection = raycaster.intersectObject(mesh, false)[0];
    if (!intersection?.uv) return null;
    const x = intersection.uv.x * W;
    const y = (1 - intersection.uv.y) * H;
    const target = targets.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    return target ? target.id : "";
  }

  return {
    mesh,
    draw,
    hit,
    dispose: () => {
      texture.dispose();
      material.dispose();
      geometry.dispose();
    },
  };
}
