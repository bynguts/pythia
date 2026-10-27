import { marked } from "marked";
import DOMPurify from "dompurify";

// Model output is untrusted (text in permits, reports or an uploaded file can steer it), so
// answers render without remote media and links stay on this site. A separate instance keeps
// the link hook away from other DOMPurify users (html2pdf).
const purifier = typeof window === "undefined" ? null : DOMPurify(window);
purifier?.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A") return;
  const href = node.getAttribute("href") || "";
  const sameSite = (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("#");
  if (!sameSite) node.removeAttribute("href");
  node.removeAttribute("target");
});

const FORBID_TAGS = [
  "style",
  "script",
  "iframe",
  "form",
  "input",
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "svg",
  "math",
  "object",
  "embed",
  "link",
  "meta",
  "base",
];

/** Markdown answer from the assistant → sanitized HTML safe for dangerouslySetInnerHTML. */
export function answerToSafeHtml(markdown) {
  const rawHtml = marked.parse(markdown, { gfm: true, breaks: true });
  return (purifier || DOMPurify).sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR: ["style", "srcset"],
  });
}
