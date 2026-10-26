import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  ChevronRight,
  CloudRain,
  Database,
  FileCheck,
  FileText,
  GitBranch,
  Hourglass,
  ListChecks,
  Mail,
  Map,
  Minus,
  Plus,
  RadioTower,
  Route,
  Smartphone,
  Sparkles,
  Truck,
  Warehouse,
  Wrench,
} from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Logo } from "../../shared/ui/Logo.jsx";
import { Mascot } from "../../shared/ui/Mascot.jsx";
import { PixelBand } from "../../shared/ui/PixelBand.jsx";
import "./landing.css";

// Where "Book a demo" and "Contact the team" go. The agency decides the contact; until a
// deployment sets VITE_CONTACT_URL the buttons point at the FAQ's contact block, which then
// hides its own "Contact the team" button.
const CONTACT_URL = import.meta.env.VITE_CONTACT_URL || "#contact";

const BAND_TOP_ROWS = [
  { ground: "#F4F3EE", dots: "#E8622A", cell: 8, height: 58 },
  { ground: "#E8622A", dots: "#F4F3EE", cell: 4, height: 58 },
];

const FOOTER_TONES = ["green", "orange", "amber", "blue", "purple", "red"];

// Decorative stepped skyline of the day-one cards (heights in 18 px steps).
const STEPS = [1, 2, 3, 1, 2, 1, 4, 3, 2, 3, 4, 3, 1];

function LinkButton({ href, to, variant = "secondary", size = "md", icon, children, ...rest }) {
  const className = `land-btn land-btn-${variant} land-btn-${size}`;
  const content = (
    <>
      {icon}
      <span>{children}</span>
    </>
  );
  if (to) {
    return (
      <Link className={className} to={to} {...rest}>
        {content}
      </Link>
    );
  }
  return (
    <a className={className} href={href} {...rest}>
      {content}
    </a>
  );
}

function Tag({ tone, children }) {
  return <span className={`land-tag land-tag-${tone}`}>{children}</span>;
}

function Steps({ tone }) {
  return (
    <svg
      className={`land-steps land-steps-${tone}`}
      viewBox={`0 0 ${STEPS.length * 29} 72`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
    >
      {STEPS.map((h, i) => (
        <rect key={i} x={i * 29} y={72 - h * 18} width="29" height={h * 18} />
      ))}
    </svg>
  );
}

function ConsoleWindow({ tabs, src, alt, url }) {
  const { t } = useLanguage();
  return (
    <div className="land-window">
      {tabs ? (
        <div className="land-window-bar">
          <ul className="land-window-tabs">
            {tabs.map(({ key, icon, label }, i) => (
              <li
                key={key}
                className={i === 0 ? "is-active" : ""}
                aria-current={i === 0 ? "true" : undefined}
              >
                {icon}
                <span>{label}</span>
              </li>
            ))}
          </ul>
          <Link className="land-window-open" to="/app">
            {t("l_tab_open")}
            <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="land-window-chrome" aria-hidden="true">
          <span />
          <span />
          <span />
          <em>{url}</em>
        </div>
      )}
      <img className="land-window-shot" src={src} alt={alt} width="1104" height="736" loading="lazy" />
    </div>
  );
}

function FaqItem({ index, question, answer, open, onToggle }) {
  const id = `land-faq-${index}`;
  return (
    <li className={`land-faq-item${open ? " is-open" : ""}`}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-a`}
          id={`${id}-q`}
          onClick={onToggle}
        >
          <span className="land-faq-n">{String(index).padStart(2, "0")}</span>
          <span className="land-faq-q">{question}</span>
          {open ? <Minus size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
        </button>
      </h3>
      <div id={`${id}-a`} role="region" aria-labelledby={`${id}-q`} hidden={!open}>
        <p>{answer}</p>
      </div>
    </li>
  );
}

export function LandingPage() {
  const { lang, setLang, t } = useLanguage();
  const [openFaq, setOpenFaq] = useState(1);
  const toggleFaq = (n) => setOpenFaq((current) => (current === n ? 0 : n));

  const tabs = [
    { key: "ops", icon: <RadioTower size={14} aria-hidden="true" />, label: t("l_tab_operations") },
    { key: "rdy", icon: <ListChecks size={14} aria-hidden="true" />, label: t("l_tab_readiness") },
    { key: "tmr", icon: <CalendarDays size={14} aria-hidden="true" />, label: t("l_tab_tomorrow") },
    { key: "gate", icon: <Warehouse size={14} aria-hidden="true" />, label: t("l_tab_gate") },
    { key: "wo", icon: <FileText size={14} aria-hidden="true" />, label: t("l_tab_orders") },
  ];

  const signals = [
    { icon: Route, k: "sig1" },
    { icon: Hourglass, k: "sig2" },
    { icon: CloudRain, k: "sig3" },
    { icon: BarChart3, k: "sig4" },
    { icon: Wrench, k: "sig5" },
  ];
  const columns = ["fleet", "gate", "fc", "field"];
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const dayBars = [51, 44, 82, 62, 36, 72, 76];
  const features = [
    [Map, "f1"],
    [Route, "f2"],
    [Hourglass, "f3"],
    [BarChart3, "f4"],
    [GitBranch, "f5"],
    [FileCheck, "f6"],
    [Smartphone, "f7"],
    [Sparkles, "f8"],
  ];
  const sources = [
    [CloudRain, "src_meteo"],
    [Map, "src_osm"],
    [Truck, "src_trips"],
    [CalendarDays, "src_holiday"],
    [Database, "src_district"],
  ];
  const footerCols = [
    [
      "foot_product",
      [
        ["foot_fleet", "/app/operations"],
        ["foot_planning", "/app/tomorrow"],
        ["foot_forecast", "/app/tomorrow"],
        ["foot_driver", "/driver"],
      ],
    ],
    [
      "foot_data",
      [
        ["foot_sources", "#honesty"],
        ["foot_labels", "#honesty"],
        ["foot_validation", "#faq"],
        ["foot_model", "#how"],
      ],
    ],
    [
      "foot_project",
      [
        ["foot_about", "#top"],
        ["foot_contact", "#contact"],
        ["foot_privacy", "#faq"],
      ],
    ],
  ];

  return (
    <div className="land" id="top">
      <header className="land-top">
        <div className="land-announce">
          <span className="land-announce-new">{t("l_announce_new")}</span>
          <Link to="/app/tomorrow">
            {t("l_announce_text")}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
        <div className="land-wrap land-nav">
          <div className="land-nav-left">
            <Link className="land-logo" to="/" aria-label="Pythia">
              <Logo />
            </Link>
          </div>
          <nav aria-label={t("l_nav_label")}>
            <ul>
              <li>
                <a className="is-active" href="#product">
                  {t("l_nav_product")}
                </a>
              </li>
              <li>
                <a href="#how">{t("l_nav_how")}</a>
              </li>
              <li>
                <a href="#honesty">{t("l_nav_honesty")}</a>
              </li>
              <li>
                <Link to="/driver">{t("l_nav_driver")}</Link>
              </li>
              <li>
                <a href="#faq">{t("l_nav_faq")}</a>
              </li>
            </ul>
          </nav>
          <div className="land-nav-right">
            <Link className="land-signin" to="/app" data-testid="landing-signin">
              {t("l_nav_signin")}
            </Link>
            <LinkButton href={CONTACT_URL} variant="primary" size="sm">
              {t("l_book_demo")}
            </LinkButton>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="land-hero land-wrap" id="product">
          <h1>
            {t("l_hero_h1_a")}
            <br />
            {t("l_hero_h1_b")}
          </h1>
          <p className="land-hero-sub">{t("l_hero_sub")}</p>
          <div className="land-hero-actions">
            <LinkButton
              href={CONTACT_URL}
              variant="primary"
              icon={<ArrowRight size={16} aria-hidden="true" />}
            >
              {t("l_book_demo")}
            </LinkButton>
            <LinkButton to="/app" data-testid="landing-open-console">
              {t("l_open_console")}
            </LinkButton>
          </div>
          <p className="land-note">{t("l_hero_note")}</p>
        </section>

        <section className="land-showcase" aria-label={t("l_shot_caption")}>
          <PixelBand className="land-showcase-band" />
          <div className="land-wrap">
            <ConsoleWindow tabs={tabs} src="/landing/shot-operations.webp" alt={t("l_shot_ops_alt")} />
          </div>
        </section>

        <section className="land-dark">
          <div className="land-built">
            <div className="land-wrap land-built-row">
              <p>{t("l_built_on")}</p>
              <ul>
                <li style={{ fontWeight: 600 }}>OpenStreetMap</li>
                <li style={{ fontWeight: 700 }}>Open-Meteo</li>
                <li style={{ fontWeight: 700 }} className="is-display">
                  Prophet
                </li>
                <li style={{ fontWeight: 800 }} className="is-display">
                  XGBoost
                </li>
                <li style={{ fontWeight: 600 }}>OR-Tools</li>
                <li style={{ fontWeight: 700 }}>deck.gl</li>
              </ul>
            </div>
          </div>
          <div className="land-wrap land-problem">
            <div className="land-problem-top">
              <div className="land-problem-head">
                <h2>
                  <span title={t("l_problem_note")} data-provenance="modelled">
                    {t("l_problem_a")}
                  </span>
                  <span className="is-lime">{t("l_problem_b")}</span>
                </h2>
                <p>{t("l_problem_p")}</p>
              </div>
              <ul className="land-signals" aria-label={t("l_sig_title")} title={t("l_sig_title")}>
                {signals.map(({ icon: Icon, k }) => (
                  <li key={k}>
                    <span className="land-signal-ic">
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <span className="land-signal-tx">
                      <strong>{t(`l_${k}_t`)}</strong>
                      <small>{t(`l_${k}_s`)}</small>
                    </span>
                    <span className="land-signal-n">{t(`l_${k}_n`)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="land-cols">
              {columns.map((c) => (
                <div key={c}>
                  <h3>{t(`l_col_${c}`)}</h3>
                  <p className="land-hi">
                    <span>{t(`l_col_${c}_hi`)}</span>
                  </p>
                  <p>{t(`l_col_${c}_b`)}</p>
                </div>
              ))}
            </div>
            <div className="land-skyline" aria-hidden="true">
              {SKYLINE.map((h, i) => (
                <span
                  key={i}
                  className={i === 33 ? "is-lime" : ""}
                  style={{ height: `${i === 33 ? 96 : h}px` }}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="land-how land-wrap" id="how">
          <div className="land-section-head">
            <h2>
              {t("l_how_h2_a")}
              <br />
              {t("l_how_h2_b")}
            </h2>
            <p>{t("l_how_p")}</p>
          </div>
          <ol className="land-steps-row" title={t("l_how_example")}>
            <li className="land-step">
              <div className="land-step-art">
                <span className="land-step-n">1</span>
                <div className="land-panel land-panel-forecast">
                  <div className="land-panel-head">
                    <strong>{t("l_s1_panel")}</strong>
                    <Tag tone="model">{t("l_tag_model")}</Tag>
                  </div>
                  <div className="land-bars" aria-hidden="true">
                    {days.map((d, i) => (
                      <div key={d}>
                        <span
                          className={i === 0 ? "is-lime" : i === 2 ? "is-green" : ""}
                          style={{ height: `${dayBars[i]}px` }}
                        />
                        <small>{t(`l_day_${d}`)}</small>
                      </div>
                    ))}
                  </div>
                  <div className="land-panel-foot">
                    <span>{t("l_s1_peak")}</span>
                    <strong>9,123 t</strong>
                  </div>
                </div>
              </div>
              <h3>{t("l_s1_title")}</h3>
              <p>{t("l_s1_body")}</p>
            </li>
            <li className="land-step">
              <div className="land-step-art">
                <span className="land-step-n">2</span>
                <div className="land-panel land-panel-plan">
                  <div className="land-panel-head">
                    <strong>{t("l_s2_panel")}</strong>
                    <small>{t("l_s2_solver")} · 20 s</small>
                  </div>
                  <dl>
                    <div>
                      <dt>{t("l_s2_trucks")}</dt>
                      <dd>495</dd>
                    </div>
                    <div>
                      <dt>{t("l_s2_waves")}</dt>
                      <dd>{t("l_s2_staggered")}</dd>
                    </div>
                    <div>
                      <dt>{t("l_s2_peak")}</dt>
                      <dd>09:00</dd>
                    </div>
                  </dl>
                  <span className="land-panel-approve">
                    <Check size={14} aria-hidden="true" />
                    {t("l_s2_approve")}
                  </span>
                </div>
              </div>
              <h3>{t("l_s2_title")}</h3>
              <p>{t("l_s2_body")}</p>
            </li>
            <li className="land-step">
              <div className="land-step-art">
                <span className="land-step-n">3</span>
                <div className="land-toast">
                  <strong>
                    <Route size={14} aria-hidden="true" />
                    {t("l_s3_route")} · T-047
                  </strong>
                  <p>{t("l_s3_route_s")}</p>
                </div>
                <div className="land-accepted">
                  <span className="land-accepted-ck">
                    <Check size={14} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{t("l_s3_accepted")}</strong>
                    <small>{t("l_s3_accepted_s")}</small>
                  </span>
                </div>
              </div>
              <h3>{t("l_s3_title")}</h3>
              <p>{t("l_s3_body")}</p>
            </li>
          </ol>
        </section>

        <section className="land-plat">
          <div className="land-wrap land-plat-head">
            <h2>
              {t("l_plat_h2_a")}
              <br />
              {t("l_plat_h2_b")}
            </h2>
            <p>{t("l_plat_p")}</p>
            <div className="land-hero-actions">
              <LinkButton
                to="/app/tomorrow"
                variant="dark"
                icon={<ArrowRight size={16} aria-hidden="true" />}
              >
                {t("l_plat_cta1")}
              </LinkButton>
              <LinkButton href="#honesty">{t("l_plat_cta2")}</LinkButton>
            </div>
          </div>
          <div className="land-plat-stage">
            <PixelBand rows={BAND_TOP_ROWS} className="land-plat-band" />
            <div className="land-wrap">
              <ConsoleWindow
                src="/landing/shot-tomorrow.webp"
                alt={t("l_shot_tomorrow_alt")}
                url={t("l_plat_url")}
              />
            </div>
          </div>
        </section>

        <section className="land-dark land-features-wrap">
          <div className="land-wrap">
            <ul className="land-features">
              {features.map(([Icon, k]) => (
                <li key={k}>
                  <span className="land-feature-ic">
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <h3>{t(`l_${k}_t`)}</h3>
                  <p>{t(`l_${k}_b`)}</p>
                </li>
              ))}
            </ul>
            <h2 className="land-day1-h">{t("l_day1_h")}</h2>
            <ul className="land-day1">
              <li>
                <Steps tone="orange" />
                <div className="land-day1-body">
                  <div className="land-day1-v">
                    <span>{t("l_day1_a_v")}</span>
                    <Tag tone="real">{t("l_tag_real")}</Tag>
                  </div>
                  <h3>{t("l_day1_a_t")}</h3>
                  <p>{t("l_day1_a_b")}</p>
                </div>
              </li>
              <li>
                <Steps tone="amber" />
                <div className="land-day1-body">
                  <div className="land-day1-v">
                    <span>{t("l_day1_b_v")}</span>
                    <Tag tone="model">{t("l_tag_model")}</Tag>
                  </div>
                  <h3>{t("l_day1_b_t")}</h3>
                  <p>{t("l_day1_b_b")}</p>
                </div>
              </li>
              <li>
                <Steps tone="lime" />
                <div className="land-day1-body">
                  <div className="land-day1-v">
                    <span>{t("l_day1_c_v")}</span>
                  </div>
                  <h3>{t("l_day1_c_t")}</h3>
                  <p>{t("l_day1_c_b")}</p>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section className="land-honesty" id="honesty">
          <div className="land-wrap">
            <div className="land-section-head">
              <h2>
                {t("l_hon_h2_a")}
                <br />
                {t("l_hon_h2_b")}
              </h2>
              <p>{t("l_hon_p")}</p>
            </div>
            <ul className="land-hon-cards">
              {[
                ["real", "l_tag_real", "l_hon1"],
                ["model", "l_tag_model", "l_hon2"],
                ["map", "l_tag_map", "l_hon3"],
              ].map(([tone, tag, k]) => (
                <li key={k}>
                  <Tag tone={tone}>{t(tag)}</Tag>
                  <p>
                    {t(`${k}_a`)}
                    <mark>{t(`${k}_hi`)}</mark>
                    {t(`${k}_b`)}
                  </p>
                </li>
              ))}
            </ul>
            <ul className="land-hon-qs">
              {["q1", "q2", "q3"].map((q) => (
                <li key={q}>
                  <h3>{t(`l_${q}_t`)}</h3>
                  <p>{t(`l_${q}_b`)}</p>
                </li>
              ))}
            </ul>
            <p className="land-reads-from">{t("l_reads_from")}</p>
            <ul className="land-sources">
              {sources.map(([Icon, k]) => (
                <li key={k}>
                  <Icon size={14} aria-hidden="true" />
                  {t(`l_${k}`)}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="land-faq land-wrap" id="faq">
          <div className="land-faq-head" id="contact">
            <h2>
              {t("l_faq_h2_a")}
              <br />
              {t("l_faq_h2_b")}
            </h2>
            <p>{t("l_faq_p")}</p>
            {/* Without a configured contact the button would only scroll the page. */}
            {CONTACT_URL !== "#contact" && (
              <LinkButton href={CONTACT_URL} icon={<Mail size={16} aria-hidden="true" />}>
                {t("l_faq_contact")}
              </LinkButton>
            )}
          </div>
          <ul className="land-faq-list">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <FaqItem
                key={n}
                index={n}
                question={t(`l_faq${n}_q`)}
                answer={t(`l_faq${n}_a`)}
                open={openFaq === n}
                onToggle={() => toggleFaq(n)}
              />
            ))}
          </ul>
        </section>

        <section className="land-cta">
          <div className="land-wrap">
            <h2>
              {t("l_cta_h2_a")}
              <br />
              {t("l_cta_h2_b")}
            </h2>
            <p>{t("l_cta_p")}</p>
            <div className="land-hero-actions">
              <LinkButton
                href={CONTACT_URL}
                variant="dark"
                icon={<ArrowRight size={16} aria-hidden="true" />}
              >
                {t("l_book_demo")}
              </LinkButton>
              <LinkButton to="/app">{t("l_open_console")}</LinkButton>
            </div>
            <ul className="land-cta-checks">
              {["l_cta_c1", "l_cta_c2", "l_cta_c3"].map((k) => (
                <li key={k}>
                  <span>
                    <Check size={12} aria-hidden="true" />
                  </span>
                  {t(k)}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="land-footer">
        <div className="land-footer-dither" aria-hidden="true" />
        <div className="land-wrap land-footer-main">
          <div className="land-footer-brand">
            <Logo />
            <p>{t("l_foot_tag")}</p>
          </div>
          {footerCols.map(([head, links]) => (
            <nav key={head} aria-labelledby={`land-${head}`}>
              <h2 id={`land-${head}`}>{t(`l_${head}`)}</h2>
              <ul>
                {links.map(([label, href]) => (
                  <li key={label}>
                    {href.startsWith("/") ? (
                      <Link to={href}>{t(`l_${label}`)}</Link>
                    ) : (
                      <a href={href}>{t(`l_${label}`)}</a>
                    )}
                  </li>
                ))}
                {head === "foot_project" && (
                  <li>
                    <button
                      type="button"
                      className="land-lang"
                      onClick={() => setLang(lang === "en" ? "id" : "en")}
                      data-testid="landing-lang"
                    >
                      {t(lang === "en" ? "l_lang_to_id" : "l_lang_to_en")}
                    </button>
                  </li>
                )}
              </ul>
            </nav>
          ))}
        </div>
        <div className="land-footer-base">
          <div className="land-wrap">
            <p>{t("l_foot_copy")}</p>
            <div className="land-footer-mascots" aria-hidden="true">
              {FOOTER_TONES.map((tone) => (
                <Mascot key={tone} size={48} tone={tone} />
              ))}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

// Decorative heights (px) of the skyline above the footer-side of the problem section.
const SKYLINE = [
  84, 134, 100, 122, 90, 89, 100, 109, 127, 107, 127, 79, 102, 69, 121, 103, 130, 113, 109, 97, 83, 115, 98,
  134, 90, 125, 76, 103, 117, 95, 128, 88, 110, 74, 108, 124, 92, 118, 99, 112, 86, 126, 94, 120, 80, 106,
  123, 91, 114, 78,
];
