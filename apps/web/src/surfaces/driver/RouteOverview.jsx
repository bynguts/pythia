import { CheckCircle2, Flag, MapPin } from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";

const W = 320;
const H = 132;
const PAD = 16;

function hasCoord(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && p.lat !== null;
}

// The stops (and the destination, when its coordinate is known) projected into
// a small box, north up, aspect kept. No basemap and no road geometry: it is an
// order sketch, labelled as such, at zero download cost.
export function sketchPoints(points) {
  const known = points.filter(hasCoord);
  if (known.length < 2) return null;
  const lats = known.map((p) => Number(p.lat));
  const lngs = known.map((p) => Number(p.lng));
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const xs = lngs.map((v) => v * kx);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...lats), Math.max(...lats)];
  const scale = Math.min(
    (W - 2 * PAD) / Math.max(maxX - minX, 1e-6),
    (H - 2 * PAD) / Math.max(maxY - minY, 1e-6),
  );
  const offX = (W - (maxX - minX) * scale) / 2;
  const offY = (H - (maxY - minY) * scale) / 2;
  return points.map((p) =>
    hasCoord(p)
      ? {
          x: Math.round((offX + (Number(p.lng) * kx - minX) * scale) * 10) / 10,
          y: Math.round((H - offY - (Number(p.lat) - minY) * scale) * 10) / 10,
        }
      : null,
  );
}

// L4: today's route at a glance, in order, before the per-stop cards. The
// turn-by-turn stays in the maps app; this answers "where next, how many left".
export function RouteOverview({ spj, destination }) {
  const { t } = useLanguage();
  const stops = spj?.stops || [];
  if (stops.length === 0) return null;
  const done = stops.filter((s) => s.status === "completed").length;
  const nextIndex = stops.findIndex((s) => s.status !== "completed");
  const points = sketchPoints([...stops, destination || {}]);

  return (
    <section className="driver-card driver-route" data-testid="driver-route-overview">
      <div className="driver-card-head">
        <h2>
          <MapPin size={18} /> {t("drv10_route_title")}
        </h2>
        <span className="driver-badge" data-testid="driver-route-progress">
          {t("drv10_route_progress").replace("{done}", done).replace("{total}", stops.length)}
        </span>
      </div>
      {points && (
        <figure className="driver-route-sketch">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={t("drv10_route_sketch_aria")
              .replace("{n}", stops.length)
              .replace("{dest}", spj.destination || "")}
            data-testid="driver-route-sketch"
          >
            <polyline
              className="driver-route-line"
              points={points
                .filter(Boolean)
                .map((p) => `${p.x},${p.y}`)
                .join(" ")}
            />
            {points.map((p, i) => {
              if (!p) return null;
              const isDest = i === stops.length;
              const state = isDest
                ? "dest"
                : stops[i].status === "completed"
                  ? "done"
                  : i === nextIndex
                    ? "next"
                    : "todo";
              return (
                <g key={i} className={`driver-route-node ${state}`} transform={`translate(${p.x} ${p.y})`}>
                  <circle r={isDest ? 9 : 8} />
                  <text dy="4" textAnchor="middle">
                    {isDest ? "T" : i + 1}
                  </text>
                </g>
              );
            })}
          </svg>
          <figcaption className="driver-muted">{t("drv10_route_sketch_label")}</figcaption>
        </figure>
      )}
      <ol className="driver-route-list">
        {stops.map((stop, i) => {
          const state = stop.status === "completed" ? "done" : i === nextIndex ? "next" : "todo";
          return (
            <li key={`${stop.name}-${i}`} className={state} data-testid={`driver-route-stop-${i}`}>
              <span className="driver-route-num" aria-hidden="true">
                {state === "done" ? <CheckCircle2 size={16} /> : i + 1}
              </span>
              <span>
                <strong>{stop.name}</strong>
                {state === "next" && <small>{t("drv10_route_next")}</small>}
              </span>
            </li>
          );
        })}
        <li className="dest">
          <span className="driver-route-num" aria-hidden="true">
            <Flag size={16} />
          </span>
          <span>
            <strong>{spj.destination}</strong>
            <small>{t("drv10_route_dest")}</small>
          </span>
        </li>
      </ol>
    </section>
  );
}
