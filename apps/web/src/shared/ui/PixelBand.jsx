import { useId } from "react";

// The 6-row dither band from the sign-in and landing frames: each row is a ground
// colour with a checkerboard of the row above's colour (8 px cells on the first
// row, 4 px after), ending in solid green.
const BAND = [
  { ground: "#F4F3EE", dots: "#E8622A", cell: 8, height: 58 },
  { ground: "#E8622A", dots: "#F4F3EE", cell: 4, height: 58 },
  { ground: "#D9A441", dots: "#E8622A", cell: 4, height: 58 },
  { ground: "#C9F27A", dots: "#D9A441", cell: 4, height: 58 },
  { ground: "#1F6B45", dots: "#C9F27A", cell: 4, height: 58 },
  { ground: "#1F6B45", cell: 0, height: 70 },
];

/**
 * Decorative pixel dither band, full width of its container.
 * @param {{ rows?: {ground: string, dots?: string, cell: number, height: number}[], className?: string }} props
 *   rows: top to bottom; cell 0 = solid row. Defaults to the 360 px design band.
 */
export function PixelBand({ rows = BAND, className = "" }) {
  const id = useId().replace(/:/g, "");
  const total = rows.reduce((sum, row) => sum + row.height, 0);
  let y = 0;
  return (
    <svg
      className={`ui-pixel-band ${className}`.trim()}
      width="100%"
      height={total}
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
    >
      <defs>
        {rows.map((row, index) =>
          row.cell ? (
            <pattern
              key={index}
              id={`${id}-${index}`}
              width={row.cell * 2}
              height={row.cell * 2}
              patternUnits="userSpaceOnUse"
            >
              <rect width={row.cell} height={row.cell} fill={row.dots} />
              <rect x={row.cell} y={row.cell} width={row.cell} height={row.cell} fill={row.dots} />
            </pattern>
          ) : null,
        )}
      </defs>
      {rows.map((row, index) => {
        const top = y;
        y += row.height;
        return (
          <g key={index}>
            <rect y={top} width="100%" height={row.height} fill={row.ground} />
            {row.cell ? (
              <rect y={top} width="100%" height={row.height} fill={`url(#${id}-${index})`} />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
