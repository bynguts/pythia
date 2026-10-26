import { Fragment } from "react";

/**
 * Table with a paper header row, row hover and tinted rows.
 * @param {{
 *   columns: { key: string, label: any, width?: number|string, align?: "left"|"right", render?: (row) => any }[],
 *   rows: object[],
 *   rowKey: (row) => string,
 *   rowTone?: (row) => "danger"|"warn"|undefined,
 *   expanded?: (row) => any,   // full-width row under the row when it returns content
 *   caption?: string,          // visually hidden caption
 *   sticky?: boolean,          // sticky header inside a scrolling parent
 *   empty?: any,               // rendered instead of the table when rows is empty
 *   onRowClick?: (row) => void,
 *   testId?: string, className?: string
 * }} props
 */
export function DataTable({
  columns,
  rows,
  rowKey,
  rowTone,
  expanded,
  caption,
  sticky = false,
  empty = null,
  onRowClick,
  testId,
  className = "",
}) {
  if (!rows.length && empty) return empty;
  return (
    <div className={`ui-table-wrap ${className}`.trim()} data-testid={testId}>
      <table className={`ui-table${sticky ? " is-sticky" : ""}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={column.align === "right" ? "is-right" : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const tone = rowTone?.(row);
            const extra = expanded?.(row);
            const classes = [tone ? `is-${tone}` : "", onRowClick ? "is-clickable" : ""].filter(Boolean);
            return (
              <Fragment key={rowKey(row)}>
                <tr
                  className={classes.length ? classes.join(" ") : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={column.align === "right" ? "is-right" : undefined}>
                      {column.render ? column.render(row) : row[column.key]}
                    </td>
                  ))}
                </tr>
                {extra && (
                  <tr className="ui-table-expanded">
                    <td colSpan={columns.length}>{extra}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
