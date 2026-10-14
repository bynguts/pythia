// The single API client. Every backend call goes through apiFetch so the base
// URL and the bearer token are resolved in one place.
import { API_URL } from "../config.js";

export class ApiError extends Error {
  constructor(status, detail, body) {
    super(detail || `Request failed (HTTP ${status})`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
}

export function apiUrl(path) {
  return `${API_URL}${path}`;
}

function storedToken() {
  try {
    return localStorage.getItem("pythia_token");
  } catch {
    return null;
  }
}

function isRawBody(body) {
  return (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer
  );
}

// Returns the raw Response, so callers can branch on status and read headers
// (e.g. the service worker's X-Pythia-Stale). A network failure rejects with
// fetch's own TypeError and an abort with its AbortError — never wrapped, so
// offline queues can tell "unreachable" from "HTTP error".
export function apiFetch(path, { method, body, headers, signal, auth = true } = {}) {
  const token = auth ? storedToken() : null;
  const hasBody = body !== undefined && body !== null;
  const jsonBody = hasBody && !isRawBody(body);
  return fetch(apiUrl(path), {
    method,
    signal,
    body: jsonBody ? JSON.stringify(body) : hasBody ? body : undefined,
    headers: {
      ...(hasBody && (jsonBody || typeof body === "string") ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      typeof body?.detail === "string" ? body.detail : typeof body?.message === "string" ? body.message : "";
    throw new ApiError(response.status, detail, body);
  }
  return body;
}

// JSON helpers: resolve to the parsed body, throw ApiError (status + server
// detail) on an HTTP error, and let network/abort errors through untouched.
export async function apiGet(path, options = {}) {
  return readJson(await apiFetch(path, { ...options, method: "GET" }));
}

export async function apiPost(path, body, options = {}) {
  return readJson(await apiFetch(path, { ...options, method: "POST", body }));
}
