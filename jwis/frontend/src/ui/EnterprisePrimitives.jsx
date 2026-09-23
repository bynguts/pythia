import React from "react";

export function JwisRouteMark() {
  return (
    <svg viewBox="0 0 38 38" fill="none" aria-hidden="true" focusable="false">
      <path d="M6 30h6c5 0 7-3 7-8v-6c0-5 3-8 8-8h5" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="5" cy="30" r="3" fill="currentColor" />
      <circle cx="33" cy="8" r="3" fill="currentColor" />
    </svg>
  );
}

export function StatusDot({ tone = "neutral", pulsing = false }) {
  return (
    <span
      className={`status-dot ${tone} ${pulsing ? "pulsing" : ""}`}
      aria-hidden="true"
    />
  );
}

export function EnterpriseBadge({ tone = "neutral", children, icon: Icon, size = "md" }) {
  return (
    <span className={`pill ${tone} pill-${size}`} data-testid="enterprise-badge">
      <StatusDot tone={tone} />
      {Icon && <Icon size={size === "sm" ? 11 : 13} style={{ marginRight: 4 }} />}
      <span>{children}</span>
    </span>
  );
}

export function MetricCard({ label, value, helper, tone = "neutral", icon: Icon, trend }) {
  return (
    <div className={`metric-card metric-${tone}`}>
      <div className="metric-header">
        <span className="metric-label">{label}</span>
        {Icon && <Icon size={15} className="metric-icon" />}
      </div>
      <div className="metric-value-row">
        <strong className="metric-value">{value}</strong>
        {trend && (
          <span className={`metric-trend ${trend.type || "neutral"}`}>
            {trend.value}
          </span>
        )}
      </div>
      {helper && <small className="metric-helper">{helper}</small>}
    </div>
  );
}
