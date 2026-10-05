import { useEffect, useState } from "react";

export interface Route {
  path: string[]; // e.g. ["reader", "12"]
  params: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [p, q = ""] = raw.split("?");
  return { path: p.split("/").filter(Boolean), params: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function href(path: string, params?: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `#/${path}${s ? "?" + s : ""}`;
}

export function go(path: string, params?: Record<string, string | number | undefined>) {
  window.location.hash = href(path, params).slice(1);
}
