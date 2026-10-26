import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check } from "lucide-react";
import {
  adoptFieldOutbox,
  dismissRejectedOperation,
  enqueueDriverOperation,
  flushDriverOutbox,
  markDriverSynced,
  OUTBOX_CHANGED_EVENT,
  OutboxStorageFullError,
  queuedStopKeys,
  readDriverOutbox,
  readLastSync,
  readRejectedOperations,
} from "./DriverOutbox.js";
import {
  announceSessionExpired,
  SESSION_EXPIRED_EVENT,
  openInstructionCount,
  useDispatchInstructions,
  useDriverSafety,
} from "./DriverPanels.jsx";
import {
  BERAT_COMPONENTS,
  DriverTabBar,
  DriverTopBar,
  InstructionsScreen,
  PRETRIP_ITEMS,
  PretripCheck,
  QueuePanel,
  RejectedList,
  SafetyGate,
  SafetyNotice,
  SignInAgain,
  SyncPill,
  TruckPickScreen,
  useStructuredInstructions,
} from "./DriverScreens.jsx";
import { FIELD_EPHEMERAL_KEY, FIELD_SESSION_MARK } from "./DriverLogin.jsx";
import { ExceptionPanel } from "./ExceptionPanel.jsx";
import { RouteScreen } from "./RouteOverview.jsx";
import { postQueueable } from "./tripApi.js";
import { TpaScreen } from "./TpaGuide.jsx";
import { rememberRecentTruck } from "./TruckPicker.jsx";
import { recordedReceipt } from "./WeighTicket.jsx";
import {
  arCapable,
  boundDriverOf,
  safetyBlocksNewWork,
  spjListPath,
  withQueuedStops,
} from "./driverHelpers.js";
import "./driver.css";
import { apiFetch, FIELD_ROLE_KEY, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Mascot } from "../../shared/ui/Mascot.jsx";

function receiptDoneFor(spj) {
  // The server is the source of truth: a receipt recorded on another device (or
  // after this browser's storage was cleared) must still count as done, or the
  // driver is asked to submit a second receipt for the same handover.
  if (spj?.receipt) return true;
  try {
    return localStorage.getItem(`pythia_receipt_${spj?.spj_id}`) === "done";
  } catch {
    return false;
  }
}

function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="driver-toast" role="status">
      <Check size={16} /> {message}
    </div>
  );
}

// ── Pre-trip check ────────────────────────────────────────────────────────────

// Posts today's check (or queues it offline); every NO files a damage report
// with its own note, brakes, engine and tyres as serious. A damage report that
// cannot reach the server queues behind the check, so dispatch is still told.
// Returns "saved", "queued" or "partial" (check saved, a report failed).
async function submitPretrip(driver, items, notes, t) {
  const failures = PRETRIP_ITEMS.filter((key) => items[key] === false);
  const noteFor = (key) =>
    (notes[key] || "").trim() || t("drv_pretrip_no_reason").replace("{label}", t(`d1_item_${key}`));
  const pretrip = {
    truck_code: driver.truck_code,
    driver_name: driver.driver_name,
    items,
    note: failures.map((key) => `${t(`d1_item_${key}`)}: ${noteFor(key)}`).join("\n"),
  };
  const damage = (key) => ({
    truck_code: driver.truck_code,
    driver_name: driver.driver_name,
    component: key,
    severity: BERAT_COMPONENTS.has(key) ? "berat" : "ringan",
    note: noteFor(key),
    source: "pretrip",
  });
  let queued = false;
  try {
    await postQueueable("/pretrip", pretrip);
  } catch (err) {
    if (!err?.network) throw err;
    await enqueueDriverOperation({ path: "/pretrip", data: pretrip, label: t("d1_pretrip_title") });
    queued = true;
  }
  let partial = false;
  for (const key of failures) {
    const data = damage(key);
    const label = `${t("d1_pretrip_title")} · ${t(`d1_item_${key}`)}`;
    if (queued) {
      await enqueueDriverOperation({ path: "/damage-reports", data, label });
      continue;
    }
    try {
      await postQueueable("/damage-reports", data);
    } catch (err) {
      if (!err?.network) {
        partial = true;
        continue;
      }
      await enqueueDriverOperation({ path: "/damage-reports", data, label });
    }
  }
  return queued ? "queued" : partial ? "partial" : "saved";
}

// ── App ───────────────────────────────────────────────────────────────────────

// R3: the last live SPJ list per truck survives a reload and a long offline
// shift. List items carry no route geometry (route_point_count only); the AR
// path is read from /spj/active-path/{truck}.
function spjCacheKey(truckCode) {
  return `pythia_driver_spj_${truckCode}`;
}

function readSpjCache(truckCode) {
  try {
    const cached = JSON.parse(localStorage.getItem(spjCacheKey(truckCode)) || "null");
    return cached && typeof cached === "object" ? cached : null;
  } catch {
    return null;
  }
}

function writeSpjCache(truckCode, patch) {
  const next = { ...(readSpjCache(truckCode) || {}), ...patch };
  try {
    localStorage.setItem(spjCacheKey(truckCode), JSON.stringify(next));
  } catch {
    // The cache is a fallback; the live list is already on screen.
  }
}

// The last GET /api/driver/session, so a bound driver keeps their truck offline.
const SESSION_CACHE_KEY = "pythia_driver_session";

function readDriverSession() {
  try {
    const cached = JSON.parse(localStorage.getItem(SESSION_CACHE_KEY) || "null");
    return cached && typeof cached === "object" ? cached : null;
  } catch {
    return null;
  }
}

function readPickedDriver() {
  try {
    return JSON.parse(localStorage.getItem("pythia_driver"));
  } catch {
    return null;
  }
}

function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pretripCacheKey(truckCode) {
  return `pythia_driver_pretrip_${truckCode}`;
}

// Today's check as this phone knows it: the saved record ({ date, items,
// created_at }; older phones stored only the date), else a queued check.
function pretripLocalRecord(truckCode) {
  try {
    const raw = localStorage.getItem(pretripCacheKey(truckCode));
    if (raw === localDay()) return { items: {}, created_at: null };
    const saved = raw ? JSON.parse(raw) : null;
    if (saved?.date === localDay()) return saved;
  } catch {
    // Storage blocked or an unreadable value: fall through to the queue.
  }
  const queued = readDriverOutbox().find(
    (item) => item.path === "/pretrip" && item.data?.truck_code === truckCode,
  );
  return queued ? { items: queued.data.items || {}, created_at: queued.queued_at } : null;
}

function rememberPretrip(truckCode, record) {
  try {
    localStorage.setItem(
      pretripCacheKey(truckCode),
      JSON.stringify({
        date: localDay(),
        items: record?.items || {},
        created_at: record?.created_at || null,
      }),
    );
  } catch {
    // Best effort.
  }
}

function readDestinations() {
  try {
    const list = JSON.parse(localStorage.getItem("pythia_driver_destinations") || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// The installed driver app opens /driver, not the command-centre login.
function useDriverManifest(lang) {
  useEffect(() => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return undefined;
    const previous = link.getAttribute("href");
    link.setAttribute(
      "href",
      lang === "en" ? "/manifest.driver.webmanifest" : "/manifest.driver.id.webmanifest",
    );
    return () => {
      if (previous) link.setAttribute("href", previous);
    };
  }, [lang]);
}

// L3: one field app. The old /field instructions are the Instruksi tab and the
// exception buttons the Lapor tab; ?tab= keeps the choice in the URL so the
// back button and the /field redirect land on the right tab.
// Wave 13: four tabs in the order of the design (instructions, route, report,
// TPA). Without ?tab= the app opens on TPA once every stop is done or a receipt
// is still owed, on the route while a stop is pending, else on instructions.
const TAB_IDS = ["instruksi", "rute", "lapor", "tpa"];

function signOutField() {
  try {
    localStorage.removeItem(FIELD_TOKEN_KEY);
    localStorage.removeItem(FIELD_ROLE_KEY);
    localStorage.removeItem(SESSION_CACHE_KEY);
  } catch {
    // Storage blocked: the gate still validates the token on load.
  }
  window.location.reload();
}

export default function DriverApp() {
  const { t, lang } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = TAB_IDS.includes(searchParams.get("tab")) ? searchParams.get("tab") : null;
  const selectTab = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("tab", id);
    else next.delete("tab");
    setSearchParams(next, { replace: true });
  };
  const [session, setSession] = useState(() => readDriverSession());
  const [pickedDriver, setPickedDriver] = useState(() => readPickedDriver());
  // A personal driver account is bound to its truck: no picker, no "change".
  const boundDriver = useMemo(() => boundDriverOf(session), [session]);
  const driver = boundDriver || pickedDriver;
  const [fleet, setFleet] = useState([]);
  const [fleetLoading, setFleetLoading] = useState(true);
  const [spjAktif, setSpjAktif] = useState(() =>
    driver ? (readSpjCache(driver.truck_code)?.aktif ?? null) : null,
  );
  const [history, setHistory] = useState(() =>
    driver ? readSpjCache(driver.truck_code)?.selesai || [] : [],
  );
  // null = today's check status not known yet: show neither the form nor the
  // done banner, so the form never flashes up for a truck already checked.
  const [pretripDone, setPretripDone] = useState(null);
  const [pretripRecord, setPretripRecord] = useState(null);
  const [pretripOpen, setPretripOpen] = useState(false);
  // The truck the driver changes away from; the pick screen's back returns to it.
  const [previousTruck, setPreviousTruck] = useState(null);
  const [toast, setToast] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  // false, or { receipt, spjId } once the receipt is sent (receipt null when queued).
  const [doneScreen, setDoneScreen] = useState(false);
  // #45: durable outbox — queued driver mutations replay on reconnect.
  const [outboxItems, setOutboxItems] = useState(() => readDriverOutbox());
  const [rejected, setRejected] = useState(() => readRejectedOperations());
  const [lastSync, setLastSync] = useState(() => readLastSync());
  const [flushing, setFlushing] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [destinations, setDestinations] = useState(() => readDestinations());
  const queuedCount = outboxItems.length;
  const safety = useDriverSafety(driver?.truck_code);
  const instructionFeed = useDispatchInstructions(driver?.truck_code);
  const planInstructions = useStructuredInstructions(driver?.truck_code);
  const blocked = safetyBlocksNewWork(safety);
  const arEnabled = useMemo(
    () =>
      arCapable({
        isSecureContext: window.isSecureContext,
        mediaDevices: navigator.mediaDevices,
        deviceMemory: navigator.deviceMemory,
      }),
    [],
  );
  useDriverManifest(lang);

  const toastTimer = useRef(null);
  const say = useCallback((msg, ms = 4000) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), ms);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Signed in without "Stay signed in on this phone": a new browser session
  // signs out (the outbox stays and sends after the next sign-in).
  useEffect(() => {
    try {
      if (localStorage.getItem(FIELD_EPHEMERAL_KEY) === "1" && !sessionStorage.getItem(FIELD_SESSION_MARK)) {
        localStorage.removeItem(FIELD_EPHEMERAL_KEY);
        signOutField();
      }
    } catch {
      // Storage blocked: nothing to check.
    }
  }, []);

  useEffect(() => {
    let token = null;
    try {
      token = localStorage.getItem(FIELD_TOKEN_KEY);
    } catch {
      // Storage blocked: no session to ask about.
    }
    if (!token) return;
    apiFetch("/driver/session", { tokenKey: FIELD_TOKEN_KEY })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        const next = {
          username: body?.username ?? null,
          role: body?.role ?? null,
          truck_code: body?.truck_code ?? null,
          display_name: body?.display_name ?? null,
          shared_account: Boolean(body?.shared_account),
        };
        const text = JSON.stringify(next);
        try {
          localStorage.setItem(SESSION_CACHE_KEY, text);
        } catch {
          // The cached copy only serves offline starts.
        }
        setSession((prev) => (JSON.stringify(prev) === text ? prev : next));
      })
      // Offline: the cached session (if any) stays in force.
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiFetch("/fleet", { tokenKey: FIELD_TOKEN_KEY })
      .then((r) => r.json())
      .then((body) => setFleet(Array.isArray(body) ? body : body.trucks || []))
      .catch(() => setOnline(false))
      .finally(() => setFleetLoading(false));
    apiFetch("/spj/destinations", { tokenKey: FIELD_TOKEN_KEY })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        const list = Array.isArray(body?.destinations) ? body.destinations : [];
        setDestinations(list);
        try {
          localStorage.setItem("pythia_driver_destinations", JSON.stringify(list));
        } catch {
          // Cached copy is optional.
        }
      })
      .catch(() => {});
  }, []);

  const drivers = useMemo(
    () =>
      [...fleet]
        .map((truck) => ({
          name: truck.driver_name,
          code: truck.truck_code,
          zone: truck.assigned_zone || null,
          plate: truck.plate_number || null,
        }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    [fleet],
  );

  const loadSpj = useCallback(() => {
    if (!driver) return;
    const truck = driver.truck_code;
    const cached = () => readSpjCache(truck) || {};
    // The server filters by truck (and always does for a bound driver); the
    // client-side match below stays as a guard.
    apiFetch(spjListPath("aktif", truck), { tokenKey: FIELD_TOKEN_KEY })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const body = await r.json();
        const mine = (body.spj || []).find((s) => s.truck_code === truck) || null;
        setSpjAktif(mine);
        if (r.headers.get("X-Pythia-Stale") === "1") {
          setOnline(false);
          return;
        }
        setOnline(true);
        markDriverSynced();
        setLastSync(readLastSync());
        writeSpjCache(truck, { aktif: mine });
      })
      .catch(() => {
        // Offline (or no service-worker copy): keep what is on screen, or the
        // last live copy saved on this phone.
        setOnline(false);
        setSpjAktif((prev) => prev || cached().aktif || null);
      });
    apiFetch(spjListPath("selesai", truck, 5), { tokenKey: FIELD_TOKEN_KEY })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const body = await r.json();
        // Newest first: the newest completed order is the one the driver is
        // working on now; receipt state comes from the server.
        const mine = (body.spj || [])
          .filter((s) => s.truck_code === truck)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        setHistory(mine);
        if (r.headers.get("X-Pythia-Stale") !== "1") {
          writeSpjCache(truck, { selesai: mine.slice(0, 5) });
        }
      })
      .catch(() => {
        setHistory((prev) => (prev.length > 0 ? prev : cached().selesai || []));
      });
  }, [driver]);

  useEffect(() => {
    loadSpj();
    const id = setInterval(loadSpj, 8000);
    return () => clearInterval(id);
  }, [loadSpj]);

  useEffect(() => {
    if (!driver) return;
    const truck = driver.truck_code;
    const local = pretripLocalRecord(truck);
    setPretripDone(local ? true : null);
    setPretripRecord(local);
    setPretripOpen(false);
    apiFetch(`/pretrip/today/${truck}`, { tokenKey: FIELD_TOKEN_KEY })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (body.done) rememberPretrip(truck, body.record);
        const record = body.record || pretripLocalRecord(truck);
        setPretripRecord(record);
        setPretripDone(Boolean(body.done) || Boolean(record));
      })
      // Offline or unreachable: a check done or queued on this phone today
      // counts; otherwise the form shows (a submission queues).
      .catch(() => setPretripDone(Boolean(pretripLocalRecord(truck))));
  }, [driver]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Item 9: the backend restarted and forgot this session.
  useEffect(() => {
    const onExpired = () => setSessionExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // #45: replay the durable queue when connectivity returns, a new operation
  // is queued, or the periodic retry fires. Never in a tight loop.
  const flushQueue = useCallback(async () => {
    if (readDriverOutbox().length === 0) {
      setOutboxItems([]);
      return;
    }
    setFlushing(true);
    try {
      const result = await flushDriverOutbox();
      setOutboxItems(readDriverOutbox());
      setRejected(readRejectedOperations());
      setLastSync(readLastSync());
      if (result.unauthorized) announceSessionExpired();
      if (result.rejected.length > 0) {
        say(t("drv6_rejected_toast").replace("{n}", result.rejected.length), 8000);
      } else if (result.flushed > 0) {
        say(t("drv_synced_n").replace("{n}", result.flushed));
      }
      if (result.flushed > 0 || result.rejected.length > 0) loadSpj();
    } finally {
      setFlushing(false);
    }
  }, [loadSpj, say, t]);

  useEffect(() => {
    adoptFieldOutbox().then((moved) => {
      if (moved > 0) setOutboxItems(readDriverOutbox());
    });
  }, []);

  useEffect(() => {
    const onChanged = () => {
      setOutboxItems(readDriverOutbox());
      setRejected(readRejectedOperations());
    };
    window.addEventListener(OUTBOX_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(OUTBOX_CHANGED_EVENT, onChanged);
  }, []);

  const flushRef = useRef(flushQueue);
  useEffect(() => {
    flushRef.current = flushQueue;
  }, [flushQueue]);
  const canFlush = queuedCount > 0 && !sessionExpired;

  // A newly queued item (or the queue found on load) is tried once at once.
  useEffect(() => {
    if (canFlush) flushRef.current();
  }, [canFlush, queuedCount]);

  useEffect(() => {
    if (!canFlush) return undefined;
    // One reconnect is one replay: browsers can fire `online` twice in a burst,
    // and a second flush right after a server error would retry at once instead
    // of waiting for the periodic retry or the driver's "try sending now".
    let lastOnline = 0;
    const onOnline = () => {
      const now = Date.now();
      if (now - lastOnline < 1500) return;
      lastOnline = now;
      flushRef.current();
    };
    window.addEventListener("online", onOnline);
    // Connectivity may return without an `online` event.
    const id = setInterval(() => flushRef.current(), 10000);
    return () => {
      window.removeEventListener("online", onOnline);
      clearInterval(id);
    };
  }, [canFlush]);

  // A new truck (picked, switched, or bound by the session on a personal
  // account's first start) starts from that truck's saved lists.
  const shownTruck = useRef(driver?.truck_code);
  useEffect(() => {
    const truck = driver?.truck_code;
    if (shownTruck.current === truck) return;
    shownTruck.current = truck;
    const cached = (truck && readSpjCache(truck)) || {};
    setSpjAktif(cached.aktif ?? null);
    setHistory(cached.selesai || []);
    setDoneScreen(false);
  }, [driver]);

  // A receipt queued offline: once the outbox no longer holds it, read the SPJ
  // once and show the stored weights in place of the pending note.
  const queuedReceiptSpj = doneScreen && !doneScreen.receipt ? doneScreen.spjId : null;
  const receiptStillQueued = Boolean(
    queuedReceiptSpj && outboxItems.some((item) => item.path === `/spj/${queuedReceiptSpj}/receipt`),
  );
  useEffect(() => {
    if (!queuedReceiptSpj || receiptStillQueued) return undefined;
    let cancelled = false;
    recordedReceipt(queuedReceiptSpj, null).then((receipt) => {
      if (cancelled || !receipt) return;
      setDoneScreen((prev) => (prev && prev.spjId === queuedReceiptSpj ? { ...prev, receipt } : prev));
    });
    return () => {
      cancelled = true;
    };
  }, [queuedReceiptSpj, receiptStillQueued]);

  const pickDriver = (d) => {
    const next = { driver_name: d.name, truck_code: d.code };
    rememberRecentTruck({ name: d.name, code: d.code, zone: d.zone || null, plate: d.plate || null });
    try {
      localStorage.setItem("pythia_driver", JSON.stringify(next));
    } catch {
      // The choice still applies for this session.
    }
    setPreviousTruck(null);
    setPickedDriver(next);
  };

  const switchDriver = () => {
    try {
      localStorage.removeItem("pythia_driver");
    } catch {
      // Nothing stored.
    }
    setPreviousTruck(pickedDriver);
    setPickedDriver(null);
  };

  const backToPrevious = () => {
    if (!previousTruck) return;
    try {
      localStorage.setItem("pythia_driver", JSON.stringify(previousTruck));
    } catch {
      // The choice still applies for this session.
    }
    setPickedDriver(previousTruck);
    setPreviousTruck(null);
  };

  const dismissRejected = (opId) => {
    dismissRejectedOperation(opId);
    setRejected(readRejectedOperations());
  };

  const sendPretrip = async (items, notes) => {
    try {
      const outcome = await submitPretrip(driver, items, notes, t);
      const record = { items, created_at: new Date().toISOString() };
      rememberPretrip(driver.truck_code, record);
      setPretripRecord(record);
      setPretripDone(true);
      setPretripOpen(false);
      say(
        outcome === "queued"
          ? t("drv_queued_offline")
          : outcome === "partial"
            ? t("drv_pretrip_damage_failed")
            : t("drv_pretrip_saved"),
      );
    } catch (err) {
      say(
        err instanceof OutboxStorageFullError
          ? t("drv6_storage_full")
          : err?.message || t("drv_pretrip_save_failed"),
        8000,
      );
    }
  };

  const syncPill = (
    <SyncPill
      online={online}
      queued={queuedCount}
      flushing={flushing}
      lastSync={lastSync}
      onOpen={() => selectTab("instruksi")}
    />
  );

  // ── Choose your truck (shared depot account) ──
  if (!driver) {
    return (
      <main className="driver-shell" data-testid="driver-app">
        <TruckPickScreen
          drivers={drivers}
          loading={fleetLoading}
          initialCode={previousTruck?.truck_code}
          onStart={pickDriver}
          onBack={previousTruck ? backToPrevious : signOutField}
          backLabel={
            previousTruck
              ? t("d1_pick_back").replace("{code}", previousTruck.truck_code)
              : t("d1_pick_sign_out")
          }
          sync={syncPill}
        />
        <Toast message={toast} />
      </main>
    );
  }

  const spjView = withQueuedStops(spjAktif, queuedStopKeys(outboxItems));
  const stops = spjView?.stops || [];
  // A stop dispatch skipped is closed like a completed one.
  const stopOpen = (s) => s.status !== "completed" && s.status !== "skipped";
  const pendingIndex = stops.findIndex(stopOpen);
  const allStopsDone = spjView && pendingIndex === -1 && stops.length > 0;
  // Newest completed SPJ still missing its receipt: `history` arrives newest
  // first, and receipt state comes from the server, so two browsers agree.
  const pendingReceipt = spjAktif ? null : history.find((s) => !s.receipt) || null;
  const receiptDue = !spjAktif && history[0] && !receiptDoneFor(history[0]) ? pendingReceipt : null;
  const deliverySpj = allStopsDone ? spjView : receiptDue;
  const openInstructions = openInstructionCount(instructionFeed.list, outboxItems);
  const tab =
    tabParam || (doneScreen || deliverySpj ? "tpa" : spjView && pendingIndex >= 0 ? "rute" : "instruksi");
  const stopsLeft = stops.filter(stopOpen).length;
  const showPretripForm = pretripDone === false && pretripOpen;
  const routeMap = tab === "rute" && !sessionExpired && Boolean(spjView) && stops.length > 0;
  // Y1kCA: the 12 h duty block fills the screen without the tab bar; its own
  // button still leads to Report.
  const gateScreen = tab === "instruksi" && blocked && !sessionExpired;
  const shellClass = [
    "driver-shell",
    gateScreen ? "is-gate" : "has-tabs",
    routeMap && "is-route-map",
    toast && "has-toast",
  ]
    .filter(Boolean)
    .join(" ");

  const queuePanel = (
    <QueuePanel
      items={outboxItems}
      flushing={flushing}
      lastSync={lastSync}
      onRetry={canFlush ? flushQueue : undefined}
    />
  );

  return (
    <main className={shellClass} data-testid="driver-app">
      {/* sY4R6: the route map is full-bleed, without the app header. */}
      {!routeMap && (
        <DriverTopBar
          truckCode={driver.truck_code}
          onChangeTruck={driver.bound ? undefined : switchDriver}
          sync={syncPill}
        />
      )}

      {sessionExpired ? (
        <SignInAgain
          username={session?.username || null}
          queued={queuedCount}
          onSignedIn={() => {
            setSessionExpired(false);
            flushRef.current();
          }}
        />
      ) : (
        <div className={`drv-body${tab === "rute" ? " is-route" : ""}`}>
          <RejectedList items={rejected} onDismiss={dismissRejected} />

          {tab === "instruksi" &&
            (blocked ? (
              <>
                {queuePanel}
                <SafetyGate safety={safety} onTellDispatch={() => selectTab("lapor")} />
              </>
            ) : pretripDone === null ? (
              <p className="drv-muted" data-testid="pretrip-loading" role="status" aria-busy="true">
                {t("d1_pretrip_loading")}
              </p>
            ) : showPretripForm ? (
              <>
                {queuePanel}
                <PretripCheck onSubmit={sendPretrip} />
              </>
            ) : (
              <>
                <SafetyNotice safety={safety} />
                <InstructionsScreen
                  driver={driver}
                  feed={instructionFeed}
                  plans={planInstructions}
                  blocked={blocked}
                  outboxItems={outboxItems}
                  pretrip={{ done: pretripDone, record: pretripRecord }}
                  onStartPretrip={() => setPretripOpen(true)}
                  say={say}
                  queuePanel={queuePanel}
                />
              </>
            ))}

          {tab === "lapor" && (
            <ExceptionPanel
              driver={driver}
              spj={spjView}
              stopIndex={pendingIndex}
              outboxItems={outboxItems}
              say={say}
            />
          )}

          {tab === "rute" &&
            (routeMap ? (
              <RouteScreen
                driver={driver}
                spj={spjView}
                pendingIndex={pendingIndex}
                destinations={destinations}
                blocked={blocked}
                arEnabled={arEnabled}
                instructionFeed={instructionFeed}
                outboxItems={outboxItems}
                safety={safety}
                online={online}
                pending={queuedCount}
                flushing={flushing}
                onStopCompleted={() => {
                  loadSpj();
                  say(t("drv_stop_done_toast"));
                  // The last stop hands over to the TPA tab, as designed.
                  if (stopsLeft <= 1) selectTab("tpa");
                }}
                onOpenInstructions={() => selectTab("instruksi")}
                say={say}
              />
            ) : (
              <section className="drv-screen drv-empty" data-testid="driver-no-spj">
                <Mascot size={80} />
                <h1 className="drv-h2">{t("drv_no_spj_desc")}</h1>
                <p className="drv-muted">{t("drv_no_spj_hint")}</p>
              </section>
            ))}

          {tab === "tpa" && (
            <TpaScreen
              driver={driver}
              spj={deliverySpj}
              routeSpj={spjView}
              stopsLeft={stopsLeft}
              destinations={destinations}
              doneScreen={doneScreen}
              onReceiptDone={(receipt, spjId) => {
                setDoneScreen({ receipt, spjId });
                loadSpj();
              }}
              onDoneBack={() => {
                setDoneScreen(false);
                selectTab(null);
              }}
              history={history}
              instructionFeed={instructionFeed}
              safety={safety}
              online={online}
              pending={queuedCount}
              flushing={flushing}
              lastSync={lastSync}
              say={say}
              onSignOut={signOutField}
            />
          )}
        </div>
      )}

      {!sessionExpired && !gateScreen && (
        <DriverTabBar tab={tab} onSelect={selectTab} instructionCount={openInstructions} />
      )}

      <Toast message={toast} />
    </main>
  );
}
