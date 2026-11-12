import { useEffect, useState } from "react";
import "./analytics.css";

const MEASUREMENT_ID = "G-M4LRYMNBJ6";
const HOST = "anbabi.southafricanorth.cloudapp.azure.com";
const CONSENT_KEY = "anbabi.googleAnalytics.consent";
const PUBLIC_ROUTES = new Set(["", "home", "how-it-works", "features", "about", "faq", "contact", "privacy", "terms", "security"]);
const AD_CONSENT = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };

type Consent = "allowed" | "denied" | null;
type AnalyticsWindow = Window & {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  [key: `ga-disable-${string}`]: boolean;
};
let tag: Promise<void> | undefined;
let configured = false;

function readConsent(): Consent {
  try {
    const saved = localStorage.getItem(CONSENT_KEY);
    return saved === "allowed" || saved === "denied" ? saved : null;
  } catch {
    return "denied";
  }
}

function permitted() {
  try {
    return location.hostname === HOST &&
      readConsent() === "allowed" &&
      localStorage.getItem("siteMetrics.disabled") !== "true" &&
      navigator.doNotTrack !== "1" &&
      !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
  } catch {
    return false;
  }
}

function currentPublicRoute() {
  const route = location.hash.replace(/^#\/?/, "").split("?")[0];
  return location.pathname === "/" && PUBLIC_ROUTES.has(route);
}

function disable() {
  const browser = window as unknown as AnalyticsWindow;
  browser[`ga-disable-${MEASUREMENT_ID}`] = true;
}

function withdraw() {
  disable();
  (window as unknown as AnalyticsWindow).gtag?.("consent", "update", { ...AD_CONSENT, analytics_storage: "denied" });
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name !== "_ga" && !name?.startsWith("_ga_")) continue;
    for (const domain of ["", HOST, "." + HOST, ".southafricanorth.cloudapp.azure.com", ".cloudapp.azure.com", ".azure.com"]) {
      document.cookie = name + "=; Max-Age=0; path=/" + (domain ? "; domain=" + domain : "");
    }
  }
}

function loadTag() {
  if (tag) return tag;
  const browser = window as unknown as AnalyticsWindow;
  browser.dataLayer ||= [];
  browser.gtag ||= function (..._args: unknown[]) { browser.dataLayer!.push(arguments); };
  browser.gtag("consent", "default", { ...AD_CONSENT, analytics_storage: "denied" });
  tag = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://www.googletagmanager.com/gtag/js?id=" + MEASUREMENT_ID;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); tag = undefined; reject(new Error("Analytics unavailable")); };
    document.head.appendChild(script);
  });
  return tag;
}

export function PublicAnalytics({ page }: { page: string }) {
  const [consent, setConsent] = useState<Consent>(readConsent);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const sync = () => setConsent(readConsent());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    let active = true;
    disable();
    // Stop collection immediately when hash navigation leaves a public page.
    const onNavigation = () => { if (!currentPublicRoute()) disable(); };
    window.addEventListener("hashchange", onNavigation);
    if (page !== "signin" && permitted() && currentPublicRoute()) {
      void loadTag().then(() => {
        if (!active || !permitted() || !currentPublicRoute()) return;
        const browser = window as unknown as AnalyticsWindow;
        browser[`ga-disable-${MEASUREMENT_ID}`] = false;
        browser.gtag?.("consent", "update", { ...AD_CONSENT, analytics_storage: "granted" });
        const location = "https://" + HOST + "/";
        if (!configured) {
          browser.gtag?.("js", new Date());
          browser.gtag?.("config", MEASUREMENT_ID, {
            send_page_view: false,
            allow_google_signals: false,
            allow_ad_personalization_signals: false,
            page_location: location,
            page_referrer: "",
            page_title: "Anbabi",
          });
          configured = true;
        }
        // Only the public origin is sent. Hashes can contain private document IDs.
        browser.gtag?.("event", "page_view", {
          send_to: MEASUREMENT_ID,
          page_location: location,
          page_referrer: "",
          page_title: "Anbabi",
        });
      }).catch(() => undefined);
    }
    return () => {
      active = false;
      disable();
      window.removeEventListener("hashchange", onNavigation);
    };
  }, [page, consent]);

  function choose(value: Exclude<Consent, null>) {
    if (value === "denied") withdraw();
    try {
      localStorage.setItem(CONSENT_KEY, value);
      setConsent(value);
    } catch {
      withdraw();
      setConsent("denied");
    }
    setEditing(false);
  }

  if (location.hostname !== HOST || page === "signin") return null;
  if (consent !== null && !editing) {
    return <button className="analytics-preferences" type="button" onClick={() => setEditing(true)}>Analytics preferences</button>;
  }
  return (
    <section className="analytics-consent" aria-label="Google Analytics preferences">
      <p>Allow Google Analytics on public pages to help improve Anbabi? <a href={hrefPrivacy}>Privacy</a></p>
      <div>
        <button type="button" onClick={() => choose("denied")}>No thanks</button>
        <button type="button" onClick={() => choose("allowed")}>Allow analytics</button>
      </div>
    </section>
  );
}
const hrefPrivacy = "#/privacy";
