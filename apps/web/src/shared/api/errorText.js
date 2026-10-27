// The words of a failed API call in the UI language. Backend `detail` text is English: a
// coded refusal ({code, params}) is said from the catalog (`lx_err_<code>`), plain detail
// only in English mode; otherwise the caller's own localized fallback.
import { translate } from "../i18n/index.jsx";

export function apiErrorText(lang, error, fallback) {
  if (error?.code) {
    const key = `lx_err_${error.code}`;
    const text = translate(lang, key);
    if (text !== key) {
      return Object.entries(error.params || {}).reduce(
        (out, [name, value]) => out.replaceAll(`{${name}}`, value ?? ""),
        text,
      );
    }
  }
  if (error?.status === 403) return translate(lang, "lx_err_forbidden");
  if (lang === "en" && error?.detail) return error.detail;
  return fallback;
}

// The fields apiErrorText reads, from a raw failed response and its parsed body.
export function responseError(status, body) {
  const detail = body?.detail;
  const coded = detail && typeof detail === "object" && !Array.isArray(detail);
  return {
    status,
    code: coded ? detail.code : null,
    params: coded ? detail.params : {},
    detail: typeof detail === "string" ? detail : coded ? detail.message : "",
  };
}
