// creator_scan.ts — multi-source one-pager: scan for US micro-creator MVP test candidates
// run via `pnpm creator-scan -- --n=20`
//
// Two engines, two different jobs (per user direction 2026-09-09 — not "fire everything
// at everything," each engine does what it's actually good at). Niches are a fixed hardcoded
// list (see pickNiches() below) — SerpAPI google_trends was tried for niche selection and
// dropped as the wrong signal (trend breakouts are news spikes, not evergreen creator niches).
//   1. Exa neural search — WHO: semantic discovery of creator profile/channel/media-kit pages
//      matching the qualitative criteria, per niche.
//   2. Brave web search — CORROBORATE: keyword search for directory/listicle/explicit-contact
//      pages in the same niche, catches what neural search misses.
// Decodo + Bright Data are deliberately NOT used here — they fetch a URL you already have or
// proxy raw HTML; they're per-candidate verification tools (Phase 3 style), not discovery
// engines. Wiring them into discovery would just burn quota for no differentiated signal.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import dotenv from "dotenv";
import { appendRun, upsertCreators } from "./registry.ts";

dotenv.config({ override: true });

// --- Settings registry (added 2026-09-10) --- all tunables (niches, follower band, activity
// window, rate limits, model name, result counts) live in config/creator_scan.json, not as
// hardcoded consts in this file. Pass --config=<path> to point at a different file (e.g. a
// per-tenant config once this becomes self-serve). Defaults here only cover a missing/partial
// file — the checked-in config/creator_scan.json is the source of truth, not this object.
interface CreatorScanConfig {
  niches: string[];
  followerMin: number;
  followerMax: number;
  activityWindowDays: number;
  countryFilter: string;
  language: string;
  defaultN: number;
  cacheTtlHours: number;
  braveRateLimitMs: number;
  instagramRateLimitMs: number;
  decodoFetchDelayMs: number;
  exaNumResults: number;
  exaTextMaxChars: number;
  braveNicheResultCount: number;
  braveContactHuntResultCount: number;
  promptTextExcerptMaxChars: number;
  structuringModel: string;
}

const CONFIG_DEFAULTS: CreatorScanConfig = {
  niches: ["business coaching", "personal finance", "fitness training", "self-improvement", "creative skills"],
  followerMin: 10_000,
  followerMax: 150_000,
  activityWindowDays: 60,
  countryFilter: "US",
  language: "English",
  defaultN: 20,
  cacheTtlHours: 6,
  braveRateLimitMs: 1100,
  instagramRateLimitMs: 500,
  decodoFetchDelayMs: 800,
  exaNumResults: 12,
  exaTextMaxChars: 500,
  braveNicheResultCount: 10,
  braveContactHuntResultCount: 6,
  promptTextExcerptMaxChars: 1000,
  structuringModel: "x-ai/grok-4.3",
};

function loadConfig(): CreatorScanConfig {
  const argv = process.argv.slice(2);
  const configArg = argv.find((a) => a.startsWith("--config="));
  const configPath = configArg ? configArg.split("=")[1] : "config/creator_scan.json";
  if (!existsSync(configPath)) {
    console.log(`==> config file ${configPath} not found — using built-in defaults`);
    return CONFIG_DEFAULTS;
  }
  try {
    const fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    return { ...CONFIG_DEFAULTS, ...fileConfig };
  } catch (err) {
    console.error(`==> failed to parse ${configPath}, using built-in defaults:`, (err as Error).message);
    return CONFIG_DEFAULTS;
  }
}

const CONFIG = loadConfig();
const TTL_6H = CONFIG.cacheTtlHours * 60 * 60 * 1000;

// Deliberately NOT importing from harvest.ts — it runs its own 5-engine harvest at module
// top-level with no guard, so importing anything from it fires a live harvest as a side effect
// (found the hard way, 2026-09-09). Small local duplicate instead; keeps this script's blast
// radius to only the calls it actually makes.
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
async function cachedFetch<T>(key: string, ttlMs: number, fetchFn: () => Promise<T>): Promise<T> {
  const cacheFile = `data/cache/${hash(key)}.json`;
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
    if (Date.now() - cached.fetched_at < ttlMs) {
      console.log(`==> cache hit: ${key.slice(0, 50)}`);
      return cached.data;
    }
  }
  const data = await fetchFn();
  if ((data && typeof data === "object" && "error" in (data as object)) || (Array.isArray(data) && data.length === 0)) {
    console.log(`==> not caching empty/error response: ${key.slice(0, 50)}`);
    return data;
  }
  mkdirSync("data/cache", { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ fetched_at: Date.now(), data }));
  return data;
}

const args = process.argv.slice(2).filter((a) => a !== "--");
const nArg = args.find((a) => a.startsWith("--n="));
const N = nArg ? parseInt(nArg.split("=")[1], 10) : CONFIG.defaultN;

interface RawHit {
  source: "exa" | "brave" | "trends";
  niche: string;
  url: string;
  title?: string;
  text?: string;
  summary?: string;
  video_id?: string;
  channel_meta?: Record<string, unknown> | null;
}

function extractVideoId(url: string): string | undefined {
  const watch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (watch) return watch[1];
  const short = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (short) return short[1];
  return undefined;
}

interface CreatorCandidate {
  handle_or_name: string;
  platform: string;
  estimated_followers: string;
  niche: string;
  channel_id?: string;
  related_pages?: string[];
  us_based: boolean;
  us_based_evidence: string;
  no_existing_product: boolean;
  product_gap_signal: string;
  contact_method: string;
  activity_recent: boolean;
  evidence_url: string;
  source_engine: string;
  verified_by_youtube_api?: boolean;
  score: number; // 0-10 composite fit
  score_rationale: string;
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

// --- CRITERIA (revised 2026-09-10: YouTube and Instagram are now BOTH first-class platforms —
// the voice-matching product requirement (extract a creator's voice/style from their content,
// per the 2026-09-09 product decision) needs Instagram reels specifically, not just YouTube
// transcripts. Restricting discovery to youtube.com (as the prior version did) structurally
// excluded every Instagram-only creator from the candidate pool.) ---
// 1. US-based (biggest, most vibrant creator market, most volume in this niche band) — tunable
//    via config.countryFilter
// 2. Follower range config.followerMin-config.followerMax on primary platform
// 3. Platform: YouTube or Instagram — both are content-minable for voice/style extraction
// 4. Niche maps to a teachable/sellable knowledge domain (business, fitness, finance,
//    self-improvement, creative skill — something a 40-60pg ebook can plausibly monetize)
// 5. No existing digital product / no store link in bio — the actual monetization gap
// 6. Active in last ~config.activityWindowDays days (not a dead/abandoned account)
// 7. Public contact method available (business email or inquiry form)
// 8. config.language content only
// All numbers/lists here are read from CONFIG (config/creator_scan.json) — nothing below is a
// literal constant; CRITERIA_TEXT is built from CONFIG at module load, not hand-written prose.
const CRITERIA_TEXT = `${CONFIG.countryFilter}-based content creators (YouTube or Instagram),
estimated ${CONFIG.followerMin.toLocaleString()}-${CONFIG.followerMax.toLocaleString()}
follower/subscriber count on their primary platform, in a teachable niche (${CONFIG.niches.join(", ")}),
who do NOT appear to already sell a digital product (no visible store link, no "shop" in bio, no
course mentioned). Must have a public business contact method. Must be active recently
(posted/uploaded within ~${CONFIG.activityWindowDays} days). ${CONFIG.language}-language content only.`;

// --- Stage 1: niche list. (Tried SerpAPI google_trends_trending_now here first — dropped it:
// trends breakouts are news/search-interest spikes ("UK investors withdraw billions"), not
// evergreen creator niches. Wrong signal for this job. Registry-configured list instead
// (config.niches); revisit only if a cleaner trends-to-niche mapping is designed later.)
function pickNiches(): string[] {
  return CONFIG.niches;
}

// --- Stage 2: Exa neural — semantic creator-profile discovery, per niche ---
// Neural search matches page-content-like statements, not instruction paragraphs — a criteria
// checklist as the query returns garbage (verified 2026-09-09: same irrelevant hit for two
// different niches). Phrase it as a statement describing the target page instead.
async function fetchExaForNiche(niche: string): Promise<RawHit[]> {
  const query = `This is a recent YouTube video from a ${niche} content creator's channel. The
creator has roughly ${CONFIG.followerMin.toLocaleString()} to ${CONFIG.followerMax.toLocaleString()} subscribers, is based in the ${CONFIG.countryFilter}, and does not
yet sell any digital product, book, or course of their own.`;
  // Raw `text` on YouTube channel pages returns generic nav chrome (JS-hydrated page, nothing
  // useful in static HTML) — verified 2026-09-09, zero candidates survived structuring as a
  // result. `summary` uses Exa's own extraction against a targeted question instead.
  const res = await cachedFetch(`exa:creator-scan:v3:${niche}`, TTL_6H, () =>
    postJson<{ results?: { url: string; title?: string; text?: string; summary?: string }[] }>(
      "https://api.exa.ai/search",
      { "x-api-key": process.env.EXA_API_KEY ?? "" },
      {
        query,
        type: "neural",
        numResults: CONFIG.exaNumResults,
        includeDomains: ["youtube.com"],
        contents: {
          text: { maxCharacters: CONFIG.exaTextMaxChars },
          summary: { query: "Approximate subscriber count, content niche, whether they sell any digital product/book/course, and any public business contact info (email, inquiry link)." },
        },
      }
    )
  );
  if ("error" in (res as object)) {
    console.error(`==> [exa:${niche}] failed:`, (res as { error: string }).error);
    return [];
  }
  const results = (res as { results?: { url: string; title?: string; text?: string; summary?: string }[] }).results ?? [];
  console.log(`==> [exa:${niche}] ${results.length} hits. First summary: "${(results[0]?.summary ?? "(none)").slice(0, 200)}..."`);
  return results.map((r) => ({ source: "exa" as const, niche, url: r.url, title: r.title, text: r.text, summary: r.summary, video_id: extractVideoId(r.url) }));
}

// --- Stage 3: Brave — keyword search for directories/listicles/explicit-contact pages ---
// Query fixed 2026-09-09: stacking 3 exact phrases ("business coaching" + "under 150k
// subscribers" + "business inquiries") returned Brave's own "bad_results":true with zero
// matches — nobody's page literally contains that exact combination of phrases. Loosened to
// real keywords instead of brittle exact-phrase stacking.
async function fetchBraveForNiche(niche: string): Promise<RawHit[]> {
  const q = encodeURIComponent(`${niche} youtube channel business email contact collab -site:youtube.com/results`);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${q}&count=${CONFIG.braveNicheResultCount}`;
  const res = await cachedFetch(`brave:creator-scan:v2:${niche}`, TTL_6H, async () => {
    const primary = await getJson<{ web?: { results?: { url: string; title?: string; description?: string }[] } }>(url, { "X-Subscription-Token": process.env.BRAVE_API_KEY ?? "" });
    if ("error" in (primary as object)) {
      return getJson(url, { "X-Subscription-Token": process.env.BRAVE_API_KEY_BACKUP ?? "" });
    }
    return primary;
  });
  if ("error" in (res as object)) {
    console.error(`==> [brave:${niche}] failed:`, (res as { error: string }).error);
    return [];
  }
  const results = (res as { web?: { results?: { url: string; title?: string; description?: string }[] } }).web?.results ?? [];
  console.log(`==> [brave:${niche}] ${results.length} hits. First excerpt: "${(results[0]?.description ?? "(none)").slice(0, 200)}..."`);
  return results.map((r) => ({ source: "brave" as const, niche, url: r.url, title: r.title, text: r.description, video_id: extractVideoId(r.url) }));
}

// --- Instagram discovery (added 2026-09-10) — same Exa neural pattern as YouTube, restricted
// to instagram.com instead. Exa's static-page extraction on IG profile pages is thinner than on
// YouTube (IG is more aggressively JS-hydrated), so `summary` (Exa's own targeted extraction) is
// the primary signal here, same as the YouTube path — `text` is kept short-and-best-effort.
function extractInstagramHandle(url: string): string | undefined {
  const m = url.match(/instagram\.com\/([a-zA-Z0-9._]+)\/?(?:$|[?#])/);
  if (!m) return undefined;
  const handle = m[1];
  // Reserved IG path segments that are not profile handles.
  if (["p", "reel", "reels", "explore", "accounts", "stories", "tv", "direct"].includes(handle)) return undefined;
  return handle;
}

async function fetchExaForNicheInstagram(niche: string): Promise<RawHit[]> {
  const query = `This is a recent Instagram post or reel from a ${niche} content creator's
profile. The creator has roughly ${CONFIG.followerMin.toLocaleString()} to ${CONFIG.followerMax.toLocaleString()} followers, is based in the ${CONFIG.countryFilter},
and does not yet sell any digital product, book, or course of their own.`;
  const res = await cachedFetch(`exa:creator-scan-ig:v1:${niche}`, TTL_6H, () =>
    postJson<{ results?: { url: string; title?: string; text?: string; summary?: string }[] }>(
      "https://api.exa.ai/search",
      { "x-api-key": process.env.EXA_API_KEY ?? "" },
      {
        query,
        type: "neural",
        numResults: CONFIG.exaNumResults,
        includeDomains: ["instagram.com"],
        contents: {
          text: { maxCharacters: CONFIG.exaTextMaxChars },
          summary: { query: "Approximate follower count, content niche, whether they sell any digital product/book/course, and any public business contact info (email, inquiry link)." },
        },
      }
    )
  );
  if ("error" in (res as object)) {
    console.error(`==> [exa-ig:${niche}] failed:`, (res as { error: string }).error);
    return [];
  }
  const results = (res as { results?: { url: string; title?: string; text?: string; summary?: string }[] }).results ?? [];
  console.log(`==> [exa-ig:${niche}] ${results.length} hits. First summary: "${(results[0]?.summary ?? "(none)").slice(0, 200)}..."`);
  return results.map((r) => ({ source: "exa" as const, niche, url: r.url, title: r.title, text: r.text, summary: r.summary }));
}

// --- Instagram profile verification — parses the public profile page's `og:description` meta
// tag (format: "1.2M Followers, 234 Following, 56 Posts - See Instagram photos and videos from
// NAME (@handle)"), which is present in the static HTML IG serves to logged-out requests and
// does not require login or the (restricted, business-account-only) Instagram Graph API. This
// is a best-effort public-data parse, not an official API — treat follower counts as real but
// treat activity-recency as UNAVAILABLE here (no post timestamps in this markup), unlike the
// YouTube path which gets a genuine per-video publishedAt. Honest about the gap rather than
// guessing: activityRecent is left undefined for Instagram, same as the LLM being told to say
// "unknown - verify manually" when no real signal exists.
function parseFollowerCount(raw: string): number | undefined {
  const m = raw.trim().match(/^([\d,.]+)\s*([KM]?)$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (Number.isNaN(n)) return undefined;
  const mult = m[2].toUpperCase() === "M" ? 1_000_000 : m[2].toUpperCase() === "K" ? 1_000 : 1;
  return Math.round(n * mult);
}

async function fetchInstagramProfileStats(handle: string): Promise<Record<string, unknown> | null> {
  try {
    const html = await cachedFetch(`ig:profile:${handle}`, TTL_6H, () => fetchPageHtml(`https://www.instagram.com/${handle}/`));
    if (!html || html.length < 200) return null;
    const ogDesc = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1];
    if (!ogDesc) return null;
    const parts = ogDesc.match(/^([\d,.KM]+)\s*Followers,\s*([\d,.KM]+)\s*Following,\s*([\d,.KM]+)\s*Posts/i);
    const followerCount = parts ? parseFollowerCount(parts[1]) : undefined;
    const bioEmails = [...new Set((html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []).filter((e) => !EMAIL_JUNK.test(e)))];
    const storeSignal = /linktr\.ee|linkin\.bio|shop\b|store\b|course\b|"buy now"/i.test(html);
    return {
      igHandle: handle,
      channelTitle: handle,
      country: "unknown", // IG's public HTML doesn't expose creator location — honest gap
      followerCount,
      descriptionEmail: bioEmails[0],
      storeSignalDetected: storeSignal, // real fetched-HTML evidence for no_existing_product
      activityRecent: undefined, // no post-timestamp data available from this static parse
    };
  } catch (err) {
    console.error(`==> [ig-verify:${handle}] fetch failed:`, String((err as Error).message).slice(0, 100));
    return null;
  }
}

// --- Stage 2.5: real channel stats via YouTube Data API v3 (2026-09-09) ---
// Tried calling hex-yt-intel's deployed /channel-meta/fetch worker route first — blocked for
// good reason: it's signed with STREAM_HMAC_SECRET, the single shared secret behind hex-yt-intel's
// ENTIRE production stream pipeline (analysis/chat/comments), with a real prior outage on record
// from this exact secret drifting. Not worth touching for a scan-and-shortlist tool. Own dedicated
// YouTube Data API key instead (self-contained, zero dependency on vIntel's infra/secrets).
// videoId -> channelId via videos.list, then channelId -> stats via channels.list. 2 quota units
// per candidate; free tier is 10,000/day.
// videoPublishedAt = the specific hit video's own publish date (real recency signal — used to
// compute activity_recent in code, not guessed by the LLM). channelDescriptionEmail = regex
// pull from channels.list's static snippet.description field, which many creators use to paste
// "Business inquiries: x@y.com" — real API data, no JS-hydrated About-page fetch required
// (contrast the contact-hunt/enrichContacts stages, which DO need a live fetch because they're
// working from search snippets, not the API's own description field).
async function fetchYoutubeChannelStats(videoId: string): Promise<Record<string, unknown> | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  const video = await cachedFetch(`yt:video:${videoId}`, TTL_6H, () =>
    getJson<{ items?: { snippet?: { channelId?: string; publishedAt?: string } }[] }>(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${key}`
    )
  );
  const videoSnippet = (video as { items?: { snippet?: { channelId?: string; publishedAt?: string } }[] }).items?.[0]?.snippet;
  const channelId = videoSnippet?.channelId;
  if (!channelId) return null;

  const channel = await cachedFetch(`yt:channel:${channelId}`, TTL_6H, () =>
    getJson<{
      items?: {
        snippet?: { title?: string; country?: string; publishedAt?: string; description?: string };
        statistics?: { subscriberCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean };
      }[];
    }>(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${key}`)
  );
  const item = (channel as { items?: { snippet?: Record<string, unknown>; statistics?: Record<string, unknown> }[] }).items?.[0];
  if (!item) return null;
  const stats = item.statistics as { subscriberCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean } | undefined;
  const description = (item.snippet as { description?: string } | undefined)?.description ?? "";
  const descriptionEmails = [...new Set((description.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []).filter((e) => !EMAIL_JUNK.test(e)))];
  const videoPublishedAt = videoSnippet?.publishedAt;
  const activityRecent = videoPublishedAt ? Date.now() - new Date(videoPublishedAt).getTime() <= CONFIG.activityWindowDays * 24 * 60 * 60 * 1000 : undefined;
  return {
    channelId,
    channelTitle: item.snippet?.title,
    country: item.snippet?.country ?? "unknown",
    channelPublishedAt: item.snippet?.publishedAt,
    channelVideoCount: stats?.videoCount ? Number(stats.videoCount) : undefined,
    subscriberCount: stats && !stats.hiddenSubscriberCount && stats.subscriberCount ? Number(stats.subscriberCount) : undefined,
    videoPublishedAt,
    activityRecent, // real signal, computed here — not an LLM guess
    descriptionEmail: descriptionEmails[0],
  };
}

function dedupeByUrl(hits: RawHit[]): RawHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = h.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Entity resolution (added 2026-09-09, user-approved "do the x-source merge"): ---
// Hits describing the SAME creator arrive split across sources (Exa surfaces their video,
// Brave surfaces a directory page holding their email). Without merging, contact info found
// under one URL never attaches to the candidate identified from another. Group by channelId
// when YouTube verification provides it (definitive); every other hit becomes its own group
// and the LLM is instructed to merge contact signals across groups by name/handle match.
interface HitGroup {
  key: string;
  label: string;
  hits: RawHit[];
  youtube_stats?: Record<string, unknown>;
}

function groupHitsByCreator(hits: RawHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const h of hits) {
    const stats = (h.channel_meta ?? undefined) as Record<string, unknown> | undefined;
    const channelId = (stats?.channelId as string | undefined) ?? (stats?.igHandle ? `ig:${stats.igHandle}` : undefined);
    const key = channelId ?? `url:${h.url}`;
    const g = groups.get(key) ?? { key, label: (stats?.channelTitle as string) ?? (stats?.igHandle as string) ?? h.title ?? h.url, hits: [] };
    g.hits.push(h);
    if (stats) g.youtube_stats = stats; // holds either YouTube or Instagram real-verification stats
    groups.set(key, g);
  }
  return [...groups.values()];
}

// --- Code-side numeric enforcement (fixes: prior version only told the LLM to "trust" real
// stats via prose — nothing actually filtered on them). When a group carries REAL follower/sub
// data (YouTube Data API or Instagram profile-page parse), drop it here if it's outside the
// qualification band or confirmed non-US, before it ever reaches the LLM. Groups with no real
// stats (search-snippet-only) pass through untouched — those still rely on LLM judgment, which
// is an honest, disclosed limitation (see meta.data_confidence in the run output), not silently
// masked as verified.
function passesHardFilter(g: HitGroup): { pass: boolean; reason?: string } {
  const stats = g.youtube_stats;
  if (!stats) return { pass: true }; // no real data to enforce against — defer to LLM
  const followers = (stats.subscriberCount ?? stats.followerCount) as number | undefined;
  if (typeof followers === "number") {
    if (followers < CONFIG.followerMin || followers > CONFIG.followerMax) {
      return { pass: false, reason: `real follower count ${followers} outside ${CONFIG.followerMin}-${CONFIG.followerMax} band` };
    }
  }
  const country = stats.country as string | undefined;
  if (country && country !== "unknown" && country !== CONFIG.countryFilter) {
    return { pass: false, reason: `real country=${country}, not ${CONFIG.countryFilter}` };
  }
  return { pass: true };
}

async function structureCandidates(raw: RawHit[]): Promise<{ candidates: CreatorCandidate[]; droppedByHardFilter: string[] }> {
  const allGroups = groupHitsByCreator(raw);
  const droppedByHardFilter: string[] = [];
  const groups = allGroups.filter((g) => {
    const verdict = passesHardFilter(g);
    if (!verdict.pass) {
      console.log(`==> [hard-filter] dropped "${g.label}": ${verdict.reason}`);
      droppedByHardFilter.push(`${g.label}: ${verdict.reason}`);
    }
    return verdict.pass;
  });
  const prompt = `You are screening creators against these criteria:
${CRITERIA_TEXT}

Below are GROUPS of search hits. Each group is EITHER one creator's channel/profile (key starts
with "UC" for YouTube or "ig:" for Instagram, contains REAL verified stats from the platform's
own API/page) OR a standalone page (directory, listicle, contact page). Multiple groups can
describe the SAME creator — e.g. one group is the channel, another group is a directory page
mentioning that creator's email. MERGE such groups: return ONE candidate per real creator. When
merging, combine evidence: if ANY hit in any related group mentions an email, "business
inquiries" link, or contact method, attach it to that creator's contact_method (extract the
actual email/link when present — do not leave "unknown" if the evidence exists). Match on
creator name/handle similarity. Discard non-creator pages and groups with no plausible creator
behind them. Do not invent data — if a field is genuinely unknowable from the evidence, say
"unknown - verify manually".

Some groups carry "verified_stats" (REAL follower/subscriber count, country, and — for YouTube
only — a real activityRecent boolean and a descriptionEmail pulled from the channel's own static
description field, not page-text guesses). Follower count and country on these groups have
ALREADY been hard-filtered in code before you saw this prompt — do not re-reject a candidate for
being outside the follower band or non-US if verified_stats is present, that check already
passed. Trust verified_stats over anything implied by summary/text. If verified_stats.
descriptionEmail is set, use it as contact_method unless a better one exists elsewhere. If
verified_stats.activityRecent is a real boolean (not undefined), copy it directly into
activity_recent — do not guess when a real value is given. When verified_stats is ABSENT, every
field (including activity_recent) is your best judgment from snippet text only — be honest and
prefer "unknown - verify manually" over a confident-sounding guess with no evidence.

Return a JSON array (max ${N} items) of:
[{
  "handle_or_name": string, "platform": string, "estimated_followers": string, "niche": string,
  "channel_id": string (copy the group_key when it starts with "UC" or "ig:", else ""),
  "related_pages": string[] (URLs of directories, contact pages, media kits, link pages — from
    groups you merged into this creator; these are where contact info lives. Empty array if none),
  "us_based": boolean, "us_based_evidence": string, "no_existing_product": boolean,
  "product_gap_signal": string, "contact_method": string, "activity_recent": boolean,
  "evidence_url": string, "source_engine": string, "verified_by_youtube_api": boolean,
  "score": number (0-10, composite fit against ALL criteria, be strict),
  "score_rationale": string (one sentence, cite which criteria are weak/strong)
}]

Groups (each with its hits' source, url, title, text excerpt):
${JSON.stringify(
   groups.map((g) => ({
     group_key: g.key,
     group_label: g.label,
     verified_stats: g.youtube_stats ?? undefined,
     hits: g.hits.map((h) => ({ source: h.source, niche: h.niche, url: h.url, title: h.title, summary: h.summary, text: (h.text ?? "").slice(0, CONFIG.promptTextExcerptMaxChars) })),
   }))
 )}`;

  const res = await postJson<{ choices?: { message?: { content?: string } }[] }>(
    "https://openrouter.ai/api/v1/chat/completions",
    { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    {
      model: process.env.CREATOR_SCAN_MODEL || CONFIG.structuringModel,
      messages: [
        { role: "system", content: "Return valid JSON only. No commentary, no markdown fences." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
    }
  );
  if ("error" in (res as object)) {
    console.error("==> structuring failed:", (res as { error: string }).error);
    return { candidates: [], droppedByHardFilter };
  }
  const content = (res as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "[]";
  try {
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("no JSON array found in LLM output");
    const candidates = JSON.parse(content.slice(start, end + 1)) as CreatorCandidate[];
    return { candidates, droppedByHardFilter };
  } catch {
    // Distinguish "LLM returned zero qualified creators" from "LLM output was unparseable" —
    // the prior version silently returned [] for both, indistinguishable in the output file.
    console.error("==> failed to parse LLM output as JSON — this run's candidate list is INCOMPLETE, not genuinely empty:", content.slice(0, 300));
    throw new Error(`structureCandidates: unparseable LLM output (${content.slice(0, 100)}...)`);
  }
}

// --- Stage 3.5: contact enrichment (added 2026-09-09) ---
// RCA: search results only SNIPPET contact pages ("business inquiries: ..."); the actual
// email lives on the page. Fetch each candidate's evidence page via the Decodo residential
// proxy (pattern proven in getinsight_id_br.ts) and regex-extract the email. YouTube channel
// pages are skipped (JS-hydrated, no static contact info).
async function fetchPageHtml(url: string): Promise<string> {
  const user = process.env.DECODO_RESIDENTIAL_USER;
  const pass = process.env.DECODO_RESIDENTIAL_PASS;
  const gateway = process.env.DECODO_RESIDENTIAL_GATEWAY;
  if (!user || !pass || !gateway) throw new Error("Decodo residential proxy creds missing");
  const { execFileP } = await import("node:child_process").then((m) => ({ execFileP: promisify(m.execFile) }));
  const { stdout } = await execFileP("curl", [
    "-s", "-k", "--max-time", "60",
    "--proxy", `https://${gateway}`,
    "--proxy-user", `${user}:${pass}`,
    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    url,
  ], { maxBuffer: 32 * 1024 * 1024, timeout: 70000 });
  return stdout;
}

const EMAIL_JUNK = /(png|jpg|jpeg|gif|webp|svg|css|js|example\.)$/i;

// Stage 3.6: per-creator contact hunt. Niche-level Brave hits are mostly generic how-to
// articles that never name a specific creator, so group-merging alone can't fill
// contact_method. For each still-unknown candidate, search the creator's NAME for
// contact-bearing pages, fetch the top non-YouTube hit via the residential proxy, extract.
async function huntContacts(candidates: CreatorCandidate[]): Promise<void> {
  for (const c of candidates) {
    if (c.contact_method && !c.contact_method.startsWith("unknown")) continue;
    const q = encodeURIComponent(`"${c.handle_or_name}" ${c.niche} email contact business -site:youtube.com`);
    try {
      const search = await cachedFetch(`brave:contact-hunt:${c.handle_or_name}`, TTL_6H, async () => {
        const primary = await getJson<{ web?: { results?: { url: string; title?: string; description?: string }[] } }>(
          `https://api.search.brave.com/res/v1/web/search?q=${q}&count=${CONFIG.braveContactHuntResultCount}`,
          { "X-Subscription-Token": process.env.BRAVE_API_KEY ?? "" }
        );
        if ("error" in (primary as object)) {
          return getJson(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=${CONFIG.braveContactHuntResultCount}`, { "X-Subscription-Token": process.env.BRAVE_API_KEY_BACKUP ?? "" });
        }
        return primary;
      });
      if ("error" in (search as object)) {
        console.error(`==> [hunt] ${c.handle_or_name}: brave failed`, (search as { error: string }).error);
        continue;
      }
      const hits = (search as { web?: { results?: { url: string; title?: string; description?: string }[] } }).web?.results ?? [];
      const pages = hits.map((h) => h.url).filter((u) => !u.includes("youtube.com") && !u.includes("youtu.be")).slice(0, 2);
      for (const url of pages) {
        const html = await cachedFetch(`contact-page:${url}`, TTL_6H, () => fetchPageHtml(url));
        if (!html || html.length < 200) continue;
        const emails = [...new Set((html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []).filter((e) => !EMAIL_JUNK.test(e)))];
        if (emails.length > 0) {
          c.contact_method = emails.slice(0, 2).join(", ");
          console.log(`==> [hunt] ${c.handle_or_name}: FOUND ${c.contact_method} (via ${url.slice(0, 60)})`);
          break;
        }
      }
      if (!c.contact_method || c.contact_method.startsWith("unknown")) {
        c.contact_method = "no public email found — check channel About page manually";
        console.log(`==> [hunt] ${c.handle_or_name}: no email in top hits`);
      }
      await new Promise((r) => setTimeout(r, CONFIG.braveRateLimitMs));
    } catch (err) {
      console.error(`==> [hunt] ${c.handle_or_name} failed:`, String((err as Error).message).slice(0, 100));
    }
  }
}

async function enrichContacts(candidates: CreatorCandidate[]): Promise<void> {
  for (const c of candidates) {
    if (c.contact_method && !c.contact_method.startsWith("unknown")) {
      console.log(`==> [contact] ${c.handle_or_name}: already has "${c.contact_method.slice(0, 50)}" from structuring — skipping fetch`);
      continue;
    }
    const pages = [...new Set([c.evidence_url, ...(c.related_pages ?? [])])].filter(
      (u) => u && !u.includes("youtube.com") && !u.includes("youtu.be")
    );
    if (pages.length === 0) {
      console.log(`==> [contact] ${c.handle_or_name}: no non-YouTube page to fetch — verify manually`);
      continue;
    }
    let found = false;
    for (const url of pages) {
      try {
        const html = await cachedFetch(`contact-page:${url}`, TTL_6H, () => fetchPageHtml(url));
        if (!html || html.length < 200) {
          console.log(`==> [contact] ${c.handle_or_name}: ${url.slice(0, 60)} returned ${html?.length ?? 0} bytes — skipping`);
          continue;
        }
        const emails = [...new Set((html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []).filter((e) => !EMAIL_JUNK.test(e)))];
        if (emails.length > 0) {
          c.contact_method = emails.slice(0, 2).join(", ");
          console.log(`==> [contact] ${c.handle_or_name}: FOUND ${c.contact_method}`);
          found = true;
          break;
        }
        if (/business\s*inquir|contact|media\s*kit/i.test(html)) {
          c.contact_method = `contact/inquiry page exists (no raw email): ${url}`;
          console.log(`==> [contact] ${c.handle_or_name}: inquiry page, no raw email`);
          found = true;
          break;
        }
      } catch (err) {
        console.error(`==> [contact] ${c.handle_or_name} fetch failed:`, String((err as Error).message).slice(0, 100));
      }
    }
    if (!found && !c.contact_method) c.contact_method = "unknown - verify manually";
    await new Promise((r) => setTimeout(r, CONFIG.decodoFetchDelayMs));
  }
}

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const startedAt = new Date().toISOString();
  // Run-level incompleteness tracking (added 2026-09-10) — the prior version zeroed out a
  // niche's hits or returned [] on any failure with only a console.error, indistinguishable in
  // the output file from a genuinely empty result. Collect reasons here and write them into
  // meta so a bad run is visibly bad, not silently mistaken for "no qualified creators."
  const incompleteReasons: string[] = [];

  console.log(`==> Stage 1/4: niches...`);
  const niches = pickNiches();
  console.log(`==> niches: ${niches.join(", ")}`);

  console.log(`==> Stage 2/4: Exa neural (YouTube + Instagram, parallel) + Brave keyword (serialized) search across ${niches.length} niches...`);
  // Exa has no tight per-second cap, safe to fan out. Brave's free tier is 1 req/sec
  // (x-ratelimit-policy: 1;w=1) — firing all niches in parallel 429s everything past the first
  // (verified 2026-09-09). Serialize with a stagger instead of racing the rate limit.
  const exaYtHits = await Promise.all(niches.map((niche) => fetchExaForNiche(niche)));
  const exaIgHits = await Promise.all(niches.map((niche) => fetchExaForNicheInstagram(niche)));
  const braveHits: RawHit[][] = [];
  for (const niche of niches) {
    const hits = await fetchBraveForNiche(niche);
    if (hits.length === 0) incompleteReasons.push(`brave niche "${niche}" returned 0 hits (rate-limit, key failure, or genuinely no results — see console log)`);
    braveHits.push(hits);
    await new Promise((r) => setTimeout(r, CONFIG.braveRateLimitMs));
  }
  exaYtHits.forEach((hits, i) => { if (hits.length === 0) incompleteReasons.push(`exa-youtube niche "${niches[i]}" returned 0 hits`); });
  exaIgHits.forEach((hits, i) => { if (hits.length === 0) incompleteReasons.push(`exa-instagram niche "${niches[i]}" returned 0 hits`); });
  const raw = dedupeByUrl([...exaYtHits.flat(), ...exaIgHits.flat(), ...braveHits.flat()]);
  console.log(`==> ${raw.length} unique raw hits after dedup across ${niches.length} niches, 3 engine passes each`);

  const withVideoId = raw.filter((r) => r.video_id);
  const igHandleByHit = new Map<RawHit, string>();
  for (const r of raw) {
    if (r.video_id) continue;
    const handle = extractInstagramHandle(r.url);
    if (handle) igHandleByHit.set(r, handle);
  }
  console.log(`==> Stage 3/4: verifying real stats — ${withVideoId.length} YouTube hits via Data API, ${igHandleByHit.size} Instagram hits via profile-page parse...`);
  if (!process.env.YOUTUBE_API_KEY) {
    console.log(`==> YOUTUBE_API_KEY not set — skipping YouTube verification, falling back to "unknown - verify manually"`);
    incompleteReasons.push("YOUTUBE_API_KEY unset — no YouTube hits code-verified this run");
  }
  await Promise.all(
    withVideoId.map(async (r) => {
      const stats = await fetchYoutubeChannelStats(r.video_id!);
      r.channel_meta = stats;
      if (stats) console.log(`==> [yt:${r.video_id}] ${stats.channelTitle} · subscriberCount=${stats.subscriberCount ?? "hidden"} · country=${stats.country} · activityRecent=${stats.activityRecent}`);
    })
  );
  // Instagram profile fetches go through the same Decodo residential proxy as contact-hunt —
  // no per-second published rate limit documented, but stagger anyway to stay a polite scraper.
  for (const [hit, handle] of igHandleByHit) {
    const stats = await fetchInstagramProfileStats(handle);
    hit.channel_meta = stats;
    if (stats) console.log(`==> [ig:${handle}] followerCount=${stats.followerCount ?? "unparsed"} · storeSignal=${stats.storeSignalDetected}`);
    await new Promise((r) => setTimeout(r, CONFIG.instagramRateLimitMs));
  }

  console.log(`==> Stage 4/4: structuring + scoring candidates against criteria...`);
  let candidates: CreatorCandidate[];
  let droppedByHardFilter: string[] = [];
  try {
    const result = await structureCandidates(raw);
    candidates = result.candidates.sort((a, b) => b.score - a.score);
    droppedByHardFilter = result.droppedByHardFilter;
  } catch (err) {
    incompleteReasons.push(`structuring failed: ${(err as Error).message}`);
    candidates = [];
  }

  console.log(`==> Stage 4.5/4: enriching contact info from evidence pages (top ${candidates.length})...`);
  await enrichContacts(candidates);

  console.log(`==> Stage 4.6/4: per-creator contact hunt (name-specific search)...`);
  await huntContacts(candidates);

  const outDir = `data/creator_scan_${runId}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "candidates.json"),
    JSON.stringify(
      {
        meta: {
          run_id: runId,
          criteria: CRITERIA_TEXT,
          niches,
          raw_hit_count: raw.length,
          incomplete_run: incompleteReasons.length > 0,
          incomplete_reasons: incompleteReasons,
          dropped_by_hard_filter: droppedByHardFilter,
        },
        candidates,
        raw_excerpts: raw,
      },
      null,
      2
    )
  );

  // Ledger update (added 2026-09-10) — appends this run to data/db/runs.jsonl and upserts every
  // candidate into data/db/creators.json (status "new" for first-seen, otherwise preserved — see
  // registry.ts). This is what makes "what's new since last time" and "what have I already
  // reviewed" answerable without re-reading every per-run candidates.json by hand.
  appendRun({
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    niches,
    raw_hit_count: raw.length,
    candidate_count: candidates.length,
    incomplete_run: incompleteReasons.length > 0,
    incomplete_reasons: incompleteReasons,
    dropped_by_hard_filter_count: droppedByHardFilter.length,
  });
  const { newCount, updatedCount } = upsertCreators(runId, candidates);
  console.log(`==> [registry] ${newCount} new creators, ${updatedCount} re-seen creators recorded in data/db/creators.json`);

  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = candidates
    .map(
      (c, i) => `<tr>
<td>${i + 1}</td><td><strong>${esc(c.handle_or_name)}</strong></td><td>${esc(c.platform)}</td>
<td>${esc(c.estimated_followers)} ${c.verified_by_youtube_api ? "🟢" : ""}</td><td>${esc(c.niche)}</td>
<td>${c.us_based ? "✅" : "❓"} <span class="dim">${esc(c.us_based_evidence)}</span></td>
<td>${c.no_existing_product ? "✅" : "⚠️"} <span class="dim">${esc(c.product_gap_signal)}</span></td>
<td>${esc(c.contact_method)}</td>
<td>${esc(c.source_engine)}</td>
<td class="score">${c.score}</td>
<td><a href="${esc(c.evidence_url)}">source</a></td>
</tr>`
    )
    .join("");

  const excerptRows = raw
    .map((r) => `<tr><td>${esc(r.source)}</td><td>${esc(r.niche)}</td><td><a href="${esc(r.url)}">${esc(r.title || r.url)}</a></td><td>${esc((r.summary || r.text || "").slice(0, 260))}...</td></tr>`)
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Creator Scan ${esc(runId)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
h1{font-size:22px}h2{font-size:17px;margin-top:40px}.meta{color:#8b949e;font-size:13px;margin-bottom:24px}
table{border-collapse:collapse;width:100%}th{cursor:pointer;user-select:none;background:#161b22;text-align:left}
th,td{padding:9px 12px;border:1px solid #30363d;font-size:13px;vertical-align:top}
tr:hover td{background:#161b22}.score{color:#3fb950;font-weight:700}.dim{color:#8b949e;font-size:11px;display:block;margin-top:2px}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body>
<h1>Creator Scan · MVP Test-Case Candidates</h1>
<div class="meta">run ${esc(runId)} · niches: ${esc(niches.join(", "))} · ${candidates.length} candidates from ${raw.length} raw hits · US-based, 10k-150k followers, teachable niche, no existing product, active, contactable · click headers to sort</div>
<table id="t"><thead><tr><th>#</th><th>Creator</th><th>Platform</th><th>Followers</th><th>Niche</th><th>US-based</th><th>Product gap</th><th>Contact</th><th>Engine</th><th>Score</th><th>Evidence</th></tr></thead>
<tbody>${rows}</tbody></table>
<h2>Raw multi-source excerpts (what each engine actually returned)</h2>
<table><thead><tr><th>Engine</th><th>Niche</th><th>Result</th><th>Excerpt</th></tr></thead><tbody>${excerptRows}</tbody></table>
<script>
document.querySelectorAll("#t th").forEach((th,i)=>th.addEventListener("click",()=>{
const tb=document.querySelector("#t tbody");const rows=[...tb.rows];const num=i===0||i===9;
rows.sort((a,b)=>{const x=a.cells[i].innerText,y=b.cells[i].innerText;return num?parseFloat(y)-parseFloat(x):x.localeCompare(y)});
tb.append(...rows)}));
</script></body></html>`;

  writeFileSync(path.join(outDir, "candidates.html"), html);
  console.log(`==> ${candidates.length} candidates written to ${outDir}/candidates.json`);
  console.log(`==> Open ${outDir}/candidates.html in browser to review and pick MVP test cases`);
}

main();
