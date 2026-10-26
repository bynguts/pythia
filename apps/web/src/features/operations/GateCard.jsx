import { useState } from "react";
import { ChevronDown, ChevronUp, Warehouse } from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { Tag } from "../../shared/ui/Tag.jsx";

// A slot this close to the day's worst modelled wait is drawn as part of the peak.
const PEAK_SHARE = 0.85;
const BAR_MAX_PX = 40;

/**
 * Bottom-right "Bantargebang gate" card: modelled wait per 15-min slot of today's
 * approved plans (GET /api/gate/slots), the slot holding now, and the peak with the
 * holds that would flatten it. No approved plan → the honest empty line.
 * @param {{ board: any|null, currentStart: string|null }} props
 */
export function GateCard({ board, currentStart }) {
  const { t } = useLanguage();
  // Folded to its header so the card stops covering the map.
  const [collapsed, setCollapsed] = useState(false);
  const slots = board?.slots || [];
  const waits = slots.map((slot) => Number(slot.expected_wait_min) || 0);
  const max = Math.max(0, ...waits);
  const peak = max > 0 ? slots[waits.indexOf(max)] : null;
  const holds = (board?.recommendations || []).filter((rec) => !rec.accepted).length;
  const axis = slots.length
    ? [0, 1, 2, 3].map((i) => slots[Math.round(((slots.length - 1) * i) / 3)]?.start)
    : [];

  return (
    <section
      className="ops-gate"
      aria-labelledby="ops-gate-title"
      data-testid="gate-card"
      data-provenance="model"
      title={t("s1_gate_hint")}
    >
      <header className="ops-gate-head">
        <Warehouse size={14} aria-hidden="true" />
        <h2 id="ops-gate-title">{t("s1_gate_card_title")}</h2>
        <Tag tone="model">{t("s1_model")}</Tag>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={collapsed ? ChevronUp : ChevronDown}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? "s1_expand" : "s1_collapse").replace("{name}", t("s1_gate_card_title"))}
          data-testid="gate-card-toggle"
          onClick={() => setCollapsed((value) => !value)}
        />
      </header>
      {collapsed ? null : slots.length ? (
        <>
          <div className="ops-gate-bars" role="img" aria-label={t("s1_gate_chart_label")}>
            {slots.map((slot, index) => {
              const tone =
                slot.start === currentStart
                  ? "now"
                  : max > 0 && waits[index] >= max * PEAK_SHARE
                    ? "peak"
                    : "base";
              return (
                <span
                  key={slot.start}
                  className={`ops-gate-bar is-${tone}`}
                  style={{ height: `${Math.max(3, Math.round((waits[index] / (max || 1)) * BAR_MAX_PX))}px` }}
                  title={`${slot.start} · ${t("s1_minutes").replace("{n}", Math.round(waits[index]))}`}
                />
              );
            })}
          </div>
          <div className="ops-gate-axis" aria-hidden="true">
            {axis.map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>
          {peak && (
            <p className="ops-gate-note" data-testid="gate-card-note">
              {t(holds > 1 ? "s1_gate_peak_hold" : holds === 1 ? "s1_gate_peak_hold_one" : "s1_gate_peak")
                .replace("{from}", peak.start)
                .replace("{to}", peak.end)
                .replace("{n}", holds)}
            </p>
          )}
        </>
      ) : (
        <p className="ops-gate-note" data-testid="gate-card-empty">
          {t(board ? "s1_gate_empty" : "s1_loading")}
        </p>
      )}
    </section>
  );
}
