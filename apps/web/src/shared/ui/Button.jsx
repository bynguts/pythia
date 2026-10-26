import { forwardRef } from "react";

/**
 * Console button. The element is a 44 px hit box; the drawn face inside is 36 px (md)
 * or 32 px (sm), and a negative block margin keeps the design's row rhythm. lg is the
 * driver app's 48 px / 15 px button.
 * @param {{
 *   variant?: "primary"|"secondary"|"dark"|"ghost"|"danger",
 *   size?: "md"|"sm"|"lg",
 *   icon?: import("react").ElementType,  // lucide icon component
 *   iconOnly?: boolean,                  // square face; pass aria-label
 *   type?: string, className?: string, children?: any
 * } & import("react").ButtonHTMLAttributes<HTMLButtonElement>} props
 * Variants: primary (green gradient), secondary (paper gradient + hairline),
 * dark (ink, Ask Ana only), ghost (text), danger (red gradient).
 */
export const Button = forwardRef(function Button(
  {
    variant = "secondary",
    size = "md",
    icon: Icon,
    iconOnly = false,
    type = "button",
    className = "",
    children,
    ...rest
  },
  ref,
) {
  const classes = ["ui-btn", `ui-btn-${variant}`, `ui-btn-${size}`, iconOnly ? "ui-btn-icon" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      <span className="ui-btn-face">
        {Icon && <Icon size={15} strokeWidth={2} aria-hidden="true" />}
        {children}
      </span>
    </button>
  );
});
