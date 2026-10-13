export function StatusPill({ tone, children }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
