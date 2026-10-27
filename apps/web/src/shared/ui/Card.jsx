/**
 * Section card: white, 10 px radius, hairline; a 56 px header (title, aside, actions)
 * over a body. Never nest a Card inside a Card.
 * @param {{
 *   title?: any, titleId?: string, as?: string,
 *   aside?: any,     // short muted text right of the title ("Next 90 minutes")
 *   sub?: any,       // a quiet line under the title, for rules or legends too long for the aside
 *   actions?: any,   // buttons at the right end of the header
 *   flush?: boolean, // body without padding (tables, lists)
 *   className?: string, bodyClassName?: string, children: any
 * }} props
 */
export function Card({
  title,
  titleId,
  as: Element = "section",
  aside,
  sub,
  actions,
  flush = false,
  className = "",
  bodyClassName = "",
  children,
  ...rest
}) {
  return (
    <Element
      className={`ui-card ${className}`.trim()}
      aria-labelledby={title && titleId ? titleId : undefined}
      {...rest}
    >
      {(title || aside || actions) && (
        <header className={`ui-card-head${sub ? " has-sub" : ""}`}>
          {title && sub ? (
            <div className="ui-card-titles">
              <h2 className="ui-card-title" id={titleId}>
                {title}
              </h2>
              <p className="ui-card-sub">{sub}</p>
            </div>
          ) : (
            title && (
              <h2 className="ui-card-title" id={titleId}>
                {title}
              </h2>
            )
          )}
          {aside && <span className="ui-card-aside">{aside}</span>}
          {actions && <div className="ui-card-actions">{actions}</div>}
        </header>
      )}
      <div className={`ui-card-body${flush ? " is-flush" : ""} ${bodyClassName}`.trim()}>{children}</div>
    </Element>
  );
}
