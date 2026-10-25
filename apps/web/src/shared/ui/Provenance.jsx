// The one chip style: an outlined 11 px uppercase mono label naming where a number
// comes from (REAL, MODEL OUTPUT, SIMULATED…). `bare` drops the outline for the
// label that sits under a metric number or a map.
export function Provenance({ kind = "proxy", bare = false, dot = false, className = "", children }) {
  const classes = ["prov", `prov-${kind}`, bare && "prov-bare", dot && "prov-dot", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} data-testid="prov">
      {children}
    </span>
  );
}
