// The Pythia bin, drawn from the exported 16×16 pixel grid
// (docs/design/export-handoff/assets/logo-mascot.html): one path per colour layer.
const OUTLINE =
  "M6 0h4v1h-4zM5 1h1v1h-1zM10 1h1v1h-1zM2 2h12v1h-12zM1 3h1v1h-1zM14 3h1v1h-1zM1 4h1v1h-1zM14 4h1v1h-1zM1 5h1v1h-1zM14 5h1v1h-1zM0 6h16v1h-16zM1 7h1v1h-1zM14 7h1v1h-1zM1 8h1v1h-1zM4 8h2v1h-2zM11 8h2v1h-2zM14 8h1v1h-1zM1 9h1v1h-1zM4 9h2v1h-2zM11 9h2v1h-2zM14 9h1v1h-1zM1 10h1v1h-1zM14 10h1v1h-1zM1 11h1v1h-1zM14 11h1v1h-1zM1 12h1v1h-1zM5 12h1v1h-1zM10 12h1v1h-1zM14 12h1v1h-1zM1 13h1v1h-1zM6 13h4v1h-4zM14 13h1v1h-1zM2 14h1v1h-1zM13 14h1v1h-1zM3 15h10v1h-10z";
const LID = "M6 1h4v1h-4zM2 3h12v1h-12zM2 4h1v1h-1zM5 4h9v1h-9z";
const SHINE = "M3 4h2v1h-2zM3 8h1v1h-1zM10 8h1v1h-1zM3 9h1v1h-1zM10 9h1v1h-1zM3 10h3v1h-3zM10 10h3v1h-3z";
const BAND = "M2 5h12v1h-12z";
const BODY =
  "M2 7h12v1h-12zM2 8h1v1h-1zM6 8h4v1h-4zM13 8h1v1h-1zM2 9h1v1h-1zM6 9h4v1h-4zM13 9h1v1h-1zM2 10h1v1h-1zM6 10h4v1h-4zM13 10h1v1h-1zM2 11h12v1h-12zM2 12h1v1h-1zM4 12h1v1h-1zM6 12h4v1h-4zM11 12h1v1h-1zM13 12h1v1h-1zM2 13h1v1h-1zM4 13h2v1h-2zM10 13h2v1h-2zM13 13h1v1h-1zM3 14h10v1h-10z";
const FEET = "M3 12h1v1h-1zM12 12h1v1h-1zM3 13h1v1h-1zM12 13h1v1h-1z";

// [lid, band, body, feet] per tone, as exported (mark = the sidebar/logo mark).
const TONES = {
  mark: ["#C9F27A", "#9FD45A", "#1F6B45", "#2A7F52"],
  green: ["#C9F27A", "#C9F27A", "#1F6B45", "#1F6B45"],
  orange: ["#F4F3EE", "#F4F3EE", "#E8622A", "#E8622A"],
  amber: ["#FFF3D6", "#FFF3D6", "#D9A441", "#D9A441"],
  blue: ["#C9F27A", "#C9F27A", "#2B5C9E", "#2B5C9E"],
  purple: ["#E9DDF7", "#E9DDF7", "#7A4FB0", "#7A4FB0"],
  ink: ["#C9F27A", "#C9F27A", "#1C1B19", "#1C1B19"],
  red: ["#F9E3DE", "#F9E3DE", "#B3381F", "#B3381F"],
};

/**
 * Pixel mascot.
 * @param {{ size?: number, tone?: keyof TONES, label?: string, className?: string }} props
 *   size: rendered px (multiples of 16 stay crisp; 24 in the sidebar, 64 on empty states).
 *   tone: colour family from the design's mascot family. label: accessible name; decorative when absent.
 */
export function Mascot({ size = 24, tone = "mark", label, className = "" }) {
  const [lid, band, body, feet] = TONES[tone] || TONES.mark;
  return (
    <svg
      className={`ui-mascot ${className}`.trim()}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      focusable="false"
    >
      <path d={OUTLINE} fill="#1C1B19" />
      <path d={LID} fill={lid} />
      <path d={SHINE} fill="#FFFFFF" />
      <path d={BAND} fill={band} />
      <path d={BODY} fill={body} />
      <path d={FEET} fill={feet} />
    </svg>
  );
}
