// trends.ts — evergreen-niche-filtered trend layer, per 2026-09-10 user direction.
//
// The problem this solves: raw trending topics (a plane crash, a war, a celebrity death) change
// hourly and are NOT teachable niches — chasing them directly would make creator-scan's niche
// selection as "unanchored" as the user was worried about. The fix is a filter, not raw
// trend-following: CONFIG.niches (config/creator_scan.json) is the STABLE evergreen taxonomy —
// it barely changes. This module pulls real trending topics (SerpAPI google_trends_trending_now)
// and classifies each one against that stable taxonomy via an LLM call — a topic only survives
// if it maps onto an evergreen niche as a teachable sub-angle. Everything considered (kept AND
// discarded) is appended to data/db/trends.jsonl, permanently — that ledger, not any one run's
// output, is the actual asset per the user's "data is the real asset" framing. Same append-only
// pattern as registry.ts's runs.jsonl, applied to trend signals instead of scan runs.
//
// Freshness/cost control: a niche with an already-logged, still-fresh (<freshnessHours) kept
// trend is NOT re-queried — the ledger is checked first, SerpAPI/LLM calls only fire for niches
// missing a fresh entry. This is the same caching discipline as everywhere else in this repo
// (6h TTL pattern), applied to trend-signal freshness rather than raw API-response caching.
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import dotenv from "dotenv";

dotenv.config({ override: true });

const TRENDS_LOG = "data/db/trends.jsonl";
const TTL_6H = 6 * 60 * 60 * 1000;

// Deliberately NOT importing from harvest.ts — same reason creator_scan.ts doesn't: harvest.ts
// runs its own 5-engine harvest at module top-level with no guard, so importing anything from it
// fires a live harvest as a side effect. Small local duplicates instead, same as creator_scan.ts.
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
async function cachedFetch<T>(key: string, ttlMs: number, fetchFn: () => Promise<T>): Promise<T> {
  const cacheFile = `data/cache/${hash(key)}.json`;
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
    if (Date.now() - cached.fetched_at < ttlMs) {
      console.log(`==> [trends] cache hit: ${key.slice(0, 50)}`);
      return cached.data;
    }
  }
  const data = await fetchFn();
  if ((data && typeof data === "object" && "error" in (data as object)) || (Array.isArray(data) && data.length === 0)) {
    console.log(`==> [trends] not caching empty/error response: ${key.slice(0, 50)}`);
    return data;
  }
  mkdirSync("data/cache", { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ fetched_at: Date.now(), data }));
  return data;
}

async function postJson<T = unknown>(url: string, headers: Record<string, string>, body: unknown): Promise<T | { error: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text()}` };
    return (await res.json()) as T;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function getJson<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T | { error: string }> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return (await res.json()) as T;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

interface TrendEntry {
  ts: string; // real ISO timestamp, event time — never fabricated (same discipline as registry.ts)
  source: string;
  raw_topic: string;
  search_volume?: number;
  increase_percentage?: number;
  categories?: string[];
  niche: string | null; // null = classified as not mapping to any evergreen niche (discarded)
  kept: boolean;
  reason: string;
}

function appendTrendEntries(entries: TrendEntry[]): void {
  mkdirSync("data/db", { recursive: true });
  for (const e of entries) appendFileSync(TRENDS_LOG, JSON.stringify(e) + "\n");
}

export function loadTrendLog(limit?: number): TrendEntry[] {
  if (!existsSync(TRENDS_LOG)) return [];
  const lines = readFileSync(TRENDS_LOG, "utf-8").trim().split("\n").filter(Boolean);
  const entries = lines.map((l) => JSON.parse(l) as TrendEntry).reverse(); // newest first
  return limit ? entries.slice(0, limit) : entries;
}

// SerpAPI google_trends_trending_now response shape confirmed against a real prior payload
// (data/run_2026-09-09T.../payload.json): { trending_searches: [{query, search_volume,
// increase_percentage, categories: [{id,name}], ...}] }.
async function fetchSerpTrends(): Promise<
  | { trending_searches?: { query: string; search_volume?: number; increase_percentage?: number; categories?: { name: string }[] }[] }
  | { error: string }
> {
  return cachedFetch("trends:serpapi:trending_now", TTL_6H, () =>
    getJson(`https://serpapi.com/search.json?engine=google_trends_trending_now&geo=US&api_key=${process.env.SERPAPI_API_KEY}`)
  );
}

// One LLM call classifies ALL pulled topics at once against the evergreen taxonomy — cheap and
// avoids N separate calls. Strict by design: a topic only survives if there's a genuine teachable
// angle for a creator in that niche, not just superficial keyword overlap. News events (a war, a
// death, a crash) are explicitly instructed to map to null unless a real teachable angle exists.
async function classifyTopicsAgainstNiches(
  topics: { query: string; search_volume?: number; increase_percentage?: number; categories?: { name: string }[] }[],
  niches: string[]
): Promise<{ topic: string; niche: string | null; reason: string }[]> {
  if (topics.length === 0) return [];
  const prompt = `Evergreen teachable niches: ${niches.join(", ")}.

Below are today's real trending search topics (from Google Trends, US). For EACH topic, decide:
does it map onto ONE of the evergreen niches above as a genuine teachable sub-angle a creator IN
that niche could make content about RIGHT NOW (e.g. "new budgeting app backlash" -> personal
finance)? Or is it unrelated breaking news/events with no real teachable-niche connection (a war,
a death, a sports result, a crash, a political event) -> map to null. Be strict — superficial
keyword overlap is not enough; there must be a genuine content angle a creator in that niche
would plausibly cover. Return a JSON array, same order/length as the input list:
[{"topic": string, "niche": string|null, "reason": string (one short phrase, why kept or discarded)}]

Topics:
${JSON.stringify(topics.map((t) => ({ query: t.query, search_volume: t.search_volume, increase_percentage: t.increase_percentage, categories: t.categories?.map((c) => c.name) })))}`;

  const res = await postJson<{ choices?: { message?: { content?: string } }[] }>(
    "https://openrouter.ai/api/v1/chat/completions",
    { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    {
      model: process.env.TREND_CLASSIFIER_MODEL || "x-ai/grok-4.3",
      messages: [
        { role: "system", content: "Return valid JSON only. No commentary, no markdown fences." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
    }
  );
  if ("error" in (res as object)) {
    console.error("==> [trends] classification call failed:", (res as { error: string }).error);
    return topics.map((t) => ({ topic: t.query, niche: null, reason: "classification call failed" }));
  }
  const content = (res as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "[]";
  try {
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("no JSON array in output");
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    console.error("==> [trends] failed to parse classification output:", content.slice(0, 200));
    return topics.map((t) => ({ topic: t.query, niche: null, reason: "parse failure" }));
  }
}

// Main entry point. Returns exactly one {niche, topic} pair per requested evergreen niche —
// NEVER fewer than requested, even if SerpAPI/classification fails entirely: a niche with no
// fresh trend just falls back to itself as the topic (today's prior static behavior), logged as
// a fallback so it's visible in the run's incomplete_reasons, not a silent degradation.
export async function getTrendingNiches(
  niches: string[],
  freshnessHours: number
): Promise<{ pairs: { niche: string; topic: string }[]; usedFallbackFor: string[] }> {
  const freshCutoff = Date.now() - freshnessHours * 60 * 60 * 1000;
  const log = loadTrendLog();
  const byNiche = new Map<string, string>();
  for (const e of log) {
    if (e.kept && e.niche && niches.includes(e.niche) && new Date(e.ts).getTime() >= freshCutoff && !byNiche.has(e.niche)) {
      byNiche.set(e.niche, e.raw_topic);
    }
  }

  const missing = niches.filter((n) => !byNiche.has(n));
  if (missing.length > 0) {
    console.log(`==> [trends] ${byNiche.size}/${niches.length} niches have a fresh (<${freshnessHours}h) logged trend; fetching live trends for the rest...`);
    const raw = await fetchSerpTrends();
    if (!("error" in raw)) {
      const items = raw.trending_searches ?? [];
      if (items.length > 0) {
        const classified = await classifyTopicsAgainstNiches(items.slice(0, 20), niches);
        const now = new Date().toISOString();
        const itemByQuery = new Map(items.map((i) => [i.query, i]));
        appendTrendEntries(
          classified.map((c) => {
            const src = itemByQuery.get(c.topic);
            return {
              ts: now,
              source: "serpapi_trends",
              raw_topic: c.topic,
              search_volume: src?.search_volume,
              increase_percentage: src?.increase_percentage,
              categories: src?.categories?.map((cat) => cat.name),
              niche: c.niche,
              kept: !!c.niche,
              reason: c.reason,
            };
          })
        );
        for (const c of classified) if (c.niche && !byNiche.has(c.niche)) byNiche.set(c.niche, c.topic);
        console.log(`==> [trends] classified ${classified.length} live topics -> ${classified.filter((c) => c.niche).length} kept, ${classified.filter((c) => !c.niche).length} discarded (logged to ${TRENDS_LOG})`);
      } else {
        console.log(`==> [trends] SerpAPI trends returned no usable topics this call`);
      }
    } else {
      console.error(`==> [trends] SerpAPI trends fetch failed:`, raw.error);
    }
  }

  const usedFallbackFor: string[] = [];
  const pairs = niches.map((n) => {
    const topic = byNiche.get(n);
    if (!topic) usedFallbackFor.push(n);
    return { niche: n, topic: topic ?? n };
  });
  return { pairs, usedFallbackFor };
}
