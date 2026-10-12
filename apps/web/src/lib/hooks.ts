"use client";
// Presentation hooks shared by the screens.
import type { Agent, SolversApi } from "@solvers/api-client";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import type { Locale } from "@/i18n/routing";
import { useSession } from "./session";

/** Clock that ticks every `ms` (countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Name and category of Solvers by id: getAgents() and, for those not in the storefront
 * (e.g. delisted), getAgent(id).
 */
export function useAgentsIndex(ids: string[]): Map<string, Agent> {
  const { api } = useSession();
  const lang = useLocale() as Locale;
  const [index, setIndex] = useState<Map<string, Agent>>(new Map());
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    (async () => {
      const all = await api.getAgents({ limit: 100, lang }).catch(() => [] as Agent[]);
      const map = new Map(all.map((a) => [a.id, a]));
      const missing = key.split(",").filter((id) => !map.has(id));
      const extra = await Promise.all(missing.map((id) => api.getAgent(id, lang).then((d) => d.agent).catch(() => null)));
      for (const a of extra) if (a) map.set(a.id, a);
      if (alive) setIndex(map);
    })();
    return () => {
      alive = false;
    };
  }, [api, key, lang]);
  return index;
}

export type MyAccess = Awaited<ReturnType<SolversApi["getMyAccess"]>>;

// In-flight access requests, per session (api) and Solver: the buy box and the trial block mount together and share
// one call. Removed from the map when done, so the next visit fetches again.
const accessInflight = new WeakMap<SolversApi, Map<string, Promise<MyAccess>>>();

function fetchAccess(api: SolversApi, slug: string): Promise<MyAccess> {
  let m = accessInflight.get(api);
  if (!m) accessInflight.set(api, (m = new Map()));
  let p = m.get(slug);
  if (!p) {
    const map = m;
    p = api.getMyAccess(slug).finally(() => map.delete(slug));
    m.set(slug, p);
  }
  return p;
}

export type MyTrials = Awaited<ReturnType<SolversApi["getMyTrials"]>>;

// Several badges on one screen (catalog cards) share one call, like the access requests above.
const trialsInflight = new WeakMap<SolversApi, Promise<MyTrials>>();

function fetchTrials(api: SolversApi): Promise<MyTrials> {
  let p = trialsInflight.get(api);
  if (!p) {
    p = api.getMyTrials().finally(() => trialsInflight.delete(api));
    trialsInflight.set(api, p);
  }
  return p;
}

/** Free trials in progress of the signed-in person, by Solver. null = signed out, loading or error. */
export function useMyTrials(): Map<string, MyTrials[number]> | null {
  const { api, status } = useSession();
  const [trials, setTrials] = useState<Map<string, MyTrials[number]> | null>(null);
  useEffect(() => {
    setTrials(null);
    if (status !== "signed-in") return;
    let live = true;
    fetchTrials(api).then(
      (list) => live && setTrials(new Map(list.map((t) => [t.agentId, t]))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, status]);
  return trials;
}

/** License and free trial of the signed-in person for this Solver. null = signed out, loading or error. */
export function useMyAccess(slug: string): MyAccess | null {
  const { api, status } = useSession();
  const [access, setAccess] = useState<MyAccess | null>(null);
  useEffect(() => {
    setAccess(null);
    if (status !== "signed-in") return;
    let live = true;
    fetchAccess(api, slug).then(
      (a) => live && setAccess(a),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, status, slug]);
  return access;
}
