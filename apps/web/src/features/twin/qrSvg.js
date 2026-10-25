// QR code as SVG path data, for the "Put this on the table" handoff.
// The encoder is qrcode-generator (MIT); this module is only imported by the
// lazy handoff dialog, so neither lands in the twin or the main chunk.
import qrcode from "qrcode-generator";

// The spec's minimum quiet zone around the symbol, in modules.
export const QR_QUIET_ZONE = 4;

/** Dark/light modules of the smallest QR code that holds `text` (byte mode, level M). */
export function qrMatrix(text, level = "M") {
  const qr = qrcode(0, level);
  qr.addData(String(text), "Byte");
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.isDark(row, col)),
  );
}

/**
 * One SVG path for the dark modules (each horizontal run is one rectangle),
 * offset by the quiet zone. `size` is the viewBox side, quiet zone included.
 */
export function qrSvgPath(text, level = "M") {
  const matrix = qrMatrix(text, level);
  const parts = [];
  matrix.forEach((cells, row) => {
    let col = 0;
    while (col < cells.length) {
      if (!cells[col]) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < cells.length && cells[col]) col += 1;
      const run = col - start;
      parts.push(`M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${run}v1h-${run}z`);
    }
  });
  return { path: parts.join(""), size: matrix.length + 2 * QR_QUIET_ZONE, modules: matrix.length };
}
