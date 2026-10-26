import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Bell,
  Check,
  ChevronsUpDown,
  Ellipsis,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { DEFAULT_WORKSPACE, WORKSPACES, workspacePath } from "../workspaces.js";
import { AssistantPanel } from "../../features/assistant/AssistantPanel.jsx";
import { apiGet } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { DayCycle } from "../../shared/ui/DayCycle.jsx";
import { Drawer } from "../../shared/ui/Drawer.jsx";
import { ErrorBoundary } from "../../shared/ui/ErrorBoundary.jsx";
import { Mascot } from "../../shared/ui/Mascot.jsx";
import { Skeleton } from "../../shared/ui/Skeleton.jsx";
import { Tag } from "../../shared/ui/Tag.jsx";
import { PAGES } from "./pages.js";
import { ConsoleContext, dayPhase, SUPERVISOR_MODE_KEY } from "./useConsole.js";

const GROUPS = [
  ["today", "f_group_today"],
  ["plan", "f_group_plan"],
];
const PHASE_TITLE = {
  plan: "f_phase_title_plan",
  ready: "f_phase_title_ready",
  run: "f_phase_title_run",
  close: "f_phase_title_close",
};

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// The clock the console runs on: operations are in Jakarta, whatever the browser's zone.
function useJakartaClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function jakartaParts(date, locale) {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const day = new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Jakarta",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
    .format(date)
    .replace(/,/g, "");
  return { time, day, hour: Number(time.slice(0, 2)) };
}

// The console frame around every /app/<page>: sidebar, top bar, Ask Ana drawer.
// It stays mounted while the page changes, so its state survives navigation.
export function ConsoleShell({ page, onLogout }) {
  const { t, lang, setLang } = useLanguage();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const role = readStored("pythia_role");
  const [permissions, setPermissions] = useState([]);
  const [storedSupervisor, setStoredSupervisor] = useState(() => readStored(SUPERVISOR_MODE_KEY) === "1");
  const [counts, setCounts] = useState({});
  const [subtitle, setSubtitle] = useState(null);
  const [devices, setDevices] = useState(null);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const searchRef = useRef(null);
  const menuRef = useRef(null);
  const menuTriggerRef = useRef(null);
  const now = useJakartaClock();
  const { time, day, hour } = jakartaParts(now, localeFor(lang));
  const phase = dayPhase(hour);
  const anaOpen = params.get("ana") === "1";

  const canSupervise = permissions.includes("operations:approve");
  const supervisorMode = canSupervise && storedSupervisor;

  useEffect(() => {
    const controller = new AbortController();
    apiGet("/auth/session", { signal: controller.signal })
      .then((body) => setPermissions(body.permissions || []))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const setNavCount = useCallback((id, count, tone = "danger") => {
    setCounts((current) => ({ ...current, [id]: { count, tone } }));
  }, []);

  // Sidebar tags (open "Needs you" items; trucks not ready for today's roll-out) and
  // the top-bar sync pill (trucks whose driver phone called in within the window).
  // A failed call leaves the tag or pill out rather than showing a stale number.
  useEffect(() => {
    let controller = null;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      apiGet("/ops/needs-you", { signal })
        .then((body) => setNavCount("operations", body.counts?.all ?? null, "danger"))
        .catch(() => {});
      apiGet("/readiness", { signal })
        .then((body) =>
          setNavCount("readiness", (body.counts?.not_ready || 0) + (body.counts?.blocked || 0), "warn"),
        )
        .catch(() => {});
      apiGet("/field/devices", { signal })
        .then((body) => setDevices(typeof body.synced === "number" ? body : null))
        .catch(() => setDevices(null));
    };
    load();
    const id = setInterval(load, 60000);
    return () => {
      clearInterval(id);
      controller?.abort();
    };
  }, [setNavCount]);

  useEffect(() => {
    setSubtitle(null);
    setNavOpen(false);
  }, [page]);

  // ⌘K / Ctrl+K focuses the search box.
  useEffect(() => {
    function onKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setNavOpen(true);
        searchRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    menuRef.current?.querySelector("[role^=menuitem]")?.focus();
    function onPointerDown(event) {
      if (!menuRef.current?.contains(event.target) && !menuTriggerRef.current?.contains(event.target))
        setMenuOpen(false);
    }
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuTriggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const setSupervisorMode = useCallback((on) => {
    setStoredSupervisor(on);
    try {
      localStorage.setItem(SUPERVISOR_MODE_KEY, on ? "1" : "0");
    } catch {
      // The toggle still applies for this visit when storage is unavailable.
    }
  }, []);
  const setAna = useCallback(
    (open) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (open) next.set("ana", "1");
          else next.delete("ana");
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const openAna = useCallback(() => setAna(true), [setAna]);

  const context = useMemo(
    () => ({
      role,
      permissions,
      canSupervise,
      supervisorMode,
      setSupervisorMode,
      setNavCount,
      setSubtitle,
      openAna,
    }),
    [role, permissions, canSupervise, supervisorMode, setSupervisorMode, setNavCount, openAna],
  );

  const roleKey = `pln6_profile_role_${role}`;
  const roleLabel = role && t(roleKey) !== roleKey ? t(roleKey) : t("pln6_profile_role_unknown");
  const accountLabel = role ? t("pln6_profile_account").replace("{u}", role) : roleLabel;
  const current = WORKSPACES.find((item) => item.id === page);
  const needle = query.trim().toLowerCase();
  const matches = (item) => !needle || t(item.key).toLowerCase().includes(needle);
  const visible = WORKSPACES.filter(matches);
  const Page = PAGES[page];

  function onSearchKeyDown(event) {
    if (event.key === "Enter" && needle && visible.length) {
      event.preventDefault();
      setQuery("");
      navigate(workspacePath(visible[0].id));
    } else if (event.key === "Escape") {
      setQuery("");
    }
  }

  const navItem = ({ id, key, icon: Icon }) => {
    const tag = counts[id];
    return (
      <Link
        key={id}
        to={workspacePath(id)}
        className="cx-nav-item"
        aria-current={id === page ? "page" : undefined}
        data-testid={`nav-${id}`}
      >
        <span className="cx-nav-face">
          <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
          <span className="cx-nav-label">{t(key)}</span>
          {tag?.count > 0 && (
            <Tag tone={tag.tone} className="cx-nav-count">
              {tag.count}
            </Tag>
          )}
        </span>
      </Link>
    );
  };

  return (
    <ConsoleContext.Provider value={context}>
      <div className={`cx${navOpen ? " is-nav-open" : ""}`} data-supervisor={supervisorMode ? "on" : "off"}>
        <aside className="cx-sidebar" id="console-sidebar" aria-label={t("f_sidebar_label")}>
          <div className="cx-org">
            <Mascot size={24} />
            <span className="cx-org-name">{t("f_org_name")}</span>
            <ChevronsUpDown size={15} aria-hidden="true" className="cx-org-chev" />
          </div>
          <label className="cx-search">
            <span className="cx-search-face">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={t("f_search_placeholder")}
                aria-label={t("f_search_label")}
                data-testid="console-search"
              />
              <kbd aria-hidden="true">⌘K</kbd>
            </span>
          </label>
          <nav
            className="cx-nav"
            id="workspace-navigation"
            data-testid="workspace-navigation"
            aria-label={t("shell_sidebar_label")}
          >
            {GROUPS.map(([group, labelKey]) => {
              const items = visible.filter((item) => item.group === group);
              if (!items.length) return null;
              return (
                <div className="cx-nav-group" key={group} role="group" aria-labelledby={`cx-group-${group}`}>
                  <span className="cx-nav-group-label" id={`cx-group-${group}`}>
                    {t(labelKey)}
                  </span>
                  {items.map(navItem)}
                </div>
              );
            })}
            {visible.some((item) => item.separated) && (
              <>
                <span className="cx-nav-sep" role="separator" data-testid="nav-separator" />
                {visible.filter((item) => item.separated).map(navItem)}
              </>
            )}
            {!visible.length && <p className="cx-nav-empty">{t("f_search_empty")}</p>}
          </nav>
          <div className="cx-sidebar-spacer" />
          <DayCycle
            phase={phase}
            title={t(PHASE_TITLE[phase])}
            time={time}
            label={t("f_daycycle_label")}
            hint={t("f_daycycle_hint")}
            labels={{
              plan: t("f_phase_plan"),
              ready: t("f_phase_ready"),
              run: t("f_phase_run"),
              close: t("f_phase_close"),
            }}
          />
          <button
            type="button"
            role="switch"
            className="cx-supervisor"
            aria-checked={supervisorMode}
            aria-disabled={!canSupervise}
            title={canSupervise ? t("f_supervisor_hint") : t("f_supervisor_locked")}
            data-testid="supervisor-toggle"
            onClick={() => canSupervise && setSupervisorMode(!supervisorMode)}
          >
            <ShieldCheck size={17} strokeWidth={1.75} aria-hidden="true" />
            <span className="cx-supervisor-label">{t("f_supervisor_mode")}</span>
            <span className="cx-switch" aria-hidden="true">
              <span />
            </span>
          </button>
          <div className="cx-user">
            <button
              type="button"
              ref={menuTriggerRef}
              className="cx-user-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls="profile-menu"
              aria-label={t("shell_profile_label")}
              data-testid="profile-button"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="cx-avatar" aria-hidden="true">
                {roleLabel.slice(0, 1)}
              </span>
              <span className="cx-user-text">
                <strong data-testid="profile-role">{roleLabel}</strong>
                <small data-testid="profile-account" title={accountLabel}>
                  {t("f_user_org")}
                </small>
              </span>
              <Ellipsis size={16} aria-hidden="true" className="cx-user-more" />
            </button>
            {menuOpen && (
              <div className="cx-menu" ref={menuRef} data-testid="profile-menu">
                <div id="profile-menu" role="menu" aria-label={t("shell_profile_label")}>
                  <div role="group" aria-label={t("shell_lang_label")}>
                    {[
                      ["en", "f_lang_en"],
                      ["id", "f_lang_id"],
                    ].map(([code, key]) => (
                      <button
                        key={code}
                        type="button"
                        role="menuitemradio"
                        aria-checked={lang === code}
                        lang={code}
                        data-testid={`profile-lang-${code}`}
                        onClick={() => {
                          setLang(code);
                          setMenuOpen(false);
                        }}
                      >
                        <span>{t(key)}</span>
                        {lang === code && <Check size={16} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                  <span className="cx-menu-sep" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="profile-menu-settings"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate(workspacePath("settings"));
                    }}
                  >
                    <Settings size={16} aria-hidden="true" />
                    <span>{t("f_nav_settings")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="cx-menu-logout"
                    data-testid="profile-logout"
                    onClick={() => {
                      setMenuOpen(false);
                      onLogout();
                    }}
                  >
                    <LogOut size={16} aria-hidden="true" />
                    <span>{t("shell_logout")}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>
        <div className="cx-scrim" role="presentation" onClick={() => setNavOpen(false)} />

        <div className="cx-main">
          <header className="cx-topbar">
            <Button
              variant="ghost"
              iconOnly
              icon={Menu}
              className="cx-menu-toggle"
              aria-label={t("f_open_menu")}
              aria-expanded={navOpen}
              aria-controls="console-sidebar"
              onClick={() => setNavOpen((open) => !open)}
            />
            <span className="cx-crumb">{current ? t(current.key) : t(`f_nav_${DEFAULT_WORKSPACE}`)}</span>
            <span className="cx-crumb-dot" aria-hidden="true" />
            <span className="cx-crumb-sub" data-testid="console-subtitle">
              {subtitle || day}
            </span>
            {devices && (
              <span
                className="cx-sync"
                data-testid="shell-status"
                title={t("f_sync_hint").replace("{m}", devices.window_minutes)}
              >
                {devices.expected
                  ? t("f_sync_of").replace("{n}", devices.synced).replace("{m}", devices.expected)
                  : t(devices.synced === 1 ? "f_sync_one" : "f_sync").replace("{n}", devices.synced)}
              </span>
            )}
            <Button
              variant="ghost"
              iconOnly
              icon={Bell}
              className="cx-bell"
              aria-label={t("f_bell")}
              title={t("f_bell")}
              onClick={() => navigate(workspacePath("operations"))}
            />
            <Button
              variant="dark"
              icon={Sparkles}
              className="cx-ask"
              aria-haspopup="dialog"
              aria-expanded={anaOpen}
              data-testid="ask-ana"
              onClick={openAna}
            >
              {t("f_ask_ana")}
            </Button>
          </header>
          <main className="cx-content" id="main">
            <ErrorBoundary name={page} key={page}>
              <Suspense fallback={<Skeleton />}>
                <Page />
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
        <Drawer
          open={anaOpen}
          onClose={() => setAna(false)}
          title={t("f_ana_title")}
          subtitle={t("f_ana_subtitle")}
          avatar={<Mascot size={24} />}
          initialFocus="#assistant-question"
          testId="ana-drawer"
        >
          <AssistantPanel />
        </Drawer>
      </div>
    </ConsoleContext.Provider>
  );
}
