// Evidence photos are shrunk on the phone before they are queued or uploaded
// (audit gap 1): a 12 MP camera file is 3–7 MB, so three of them per stop
// overflow localStorage, nginx's body limit and a prepaid data plan. Every
// photo is redrawn on a canvas, longest side PHOTO_MAX_SIDE, JPEG at
// PHOTO_QUALITY, which lands at roughly 100–300 KB.

export const PHOTO_MAX_SIDE = 1280;
export const PHOTO_QUALITY = 0.7;
// Larger inputs are refused before decoding: a 2 GB phone cannot afford it.
export const PHOTO_MAX_INPUT_BYTES = 25 * 1024 * 1024;
// A file the browser cannot decode (an odd format) is kept as-is only when it
// is already small; anything bigger is refused rather than sent raw.
export const PHOTO_RAW_FALLBACK_BYTES = 1024 * 1024;

// Scale (width, height) so the longest side is at most `max`; never upscale.
export function fitWithin(width, height, max = PHOTO_MAX_SIDE) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

// Decoded byte size of a base64 data URL (what the server stores).
export function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== "string") return 0;
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

// "212 KB" / "3,8 MB" (Indonesian decimal comma) / "3.8 MB".
export function formatBytes(bytes, lang = "id") {
  const n = Math.max(0, Number(bytes) || 0);
  const locale = lang === "en" ? "en-GB" : "id-ID";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;
}

function photoError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(photoError("photo_read_failed"));
    reader.readAsDataURL(file);
  });
}

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    // EXIF orientation applied, so portrait shots stay upright.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

function jpegName(name) {
  const base = String(name || "foto").replace(/\.[^.]+$/, "");
  return `${base || "foto"}.jpg`;
}

// Returns { name, b64, bytes, originalBytes, resized }. Throws an Error whose
// `code` is photo_too_big | photo_read_failed | photo_unreadable; the caller
// translates the code.
export async function shrinkPhoto(file) {
  if (!file) throw photoError("photo_read_failed");
  if (file.size > PHOTO_MAX_INPUT_BYTES) throw photoError("photo_too_big");
  let decoded;
  try {
    decoded = await decode(file);
  } catch {
    if (file.size <= PHOTO_RAW_FALLBACK_BYTES) {
      const b64 = await readAsDataUrl(file);
      return { name: file.name, b64, bytes: dataUrlBytes(b64), originalBytes: file.size, resized: false };
    }
    throw photoError("photo_unreadable");
  }
  const canvas = document.createElement("canvas");
  try {
    const { width, height } = fitWithin(decoded.width, decoded.height);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw photoError("photo_unreadable");
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const b64 = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
    return {
      name: jpegName(file.name),
      b64,
      bytes: dataUrlBytes(b64),
      originalBytes: file.size,
      resized: true,
    };
  } finally {
    decoded.release();
    // Free the bitmap memory now; a budget phone keeps few of these.
    canvas.width = 0;
    canvas.height = 0;
  }
}
