// Service-worker registration and the localized "new version" banner.

// Necessary: skip SW registration under test automation. The worker serves
// cache-first responses that Playwright route stubs cannot intercept, which
// made stubbed command-center snapshots (field dispatch flows) never reach
// the UI. Same determinism pattern as LiveFleetMap's IS_AUTOMATION.
const IS_AUTOMATION = typeof navigator !== "undefined" && Boolean(navigator.webdriver);

// #84: the update prompt lives outside React, so it reads the stored locale
// directly and re-renders when the language context broadcasts a change.
function showUpdateBanner(registration) {
  const SW_UPDATE_COPY = {
    id: "Versi baru tersedia — Muat ulang",
    en: "New version available — Reload",
  };
  const readLang = () => {
    try {
      return localStorage.getItem("pythia_lang") || "id";
    } catch {
      return "id";
    }
  };
  let banner = null;
  const render = () => {
    banner?.remove();
    banner = document.createElement("button");
    banner.type = "button";
    banner.className = "sw-update-banner";
    banner.textContent = SW_UPDATE_COPY[readLang()] || SW_UPDATE_COPY.id;
    banner.style.cssText =
      "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9999;" +
      "padding:12px 24px;min-height:44px;font-size:16px;font-weight:600;" +
      "background:#1f2937;color:#fff;border:none;border-radius:999px;cursor:pointer;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.25)";
    banner.addEventListener("click", () => {
      registration.waiting?.postMessage("SKIP_WAITING");
      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
      // Fallback if no waiting worker (e.g. already activated): hard reload.
      setTimeout(() => location.reload(), 1500);
    });
    document.body.appendChild(banner);
  };
  render();
  window.addEventListener("pythia-lang-change", render);
}
// Integration/test hook: drives the real prompt code path without needing a
// genuine waiting worker (guarded registration is skipped under automation).
if (typeof window !== "undefined") {
  window.pythiaShowUpdatePrompt = () => showUpdateBanner(navigator.serviceWorker?.controller || {});
}

if (import.meta.env.PROD && !IS_AUTOMATION && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              showUpdateBanner(registration);
            }
          });
        });
      })
      .catch(() => {});
  });
}

if (import.meta.env.DEV && "serviceWorker" in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    })
    .catch(() => {});
}
