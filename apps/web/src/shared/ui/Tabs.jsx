// Panel tabs: a cream track, the selected tab a white pill. Arrow keys move the
// selection (roving tabindex); panels use id `${idBase}-panel-${value}`.
export function Tabs({ label, items, value, onChange, idBase }) {
  function onKeyDown(event) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = items.findIndex((item) => item.value === value);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + step + items.length) % items.length;
    onChange(items[next].value);
    event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  }
  return (
    <div className="ui-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            className="ui-tab"
            id={`${idBase}-tab-${item.value}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            data-testid={item.testId}
            onClick={() => onChange(item.value)}
          >
            {item.label}
            {item.count > 0 && <span className="ui-tab-count">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
