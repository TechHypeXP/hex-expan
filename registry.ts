// registry.ts — file-based creator-scan ledger, designed to migrate 1:1 into a real DB later.
//
// Two files, deliberately dumb (JSONL + one JSON object), per the repo's format-per-layer
// policy (see AGENTS.md): a run log you never rewrite, and a creator registry you upsert into.
// This is NOT a new data-format tier — it's the same "machine JSON + append-only log" pattern
// harvest.ts/score.ts already use for `data/index.jsonl`, applied to creator_scan.ts.
//
// Future Postgres/Supabase schema this is designed to become (not built yet — file-first until
// multi-device/multi-user access actually requires a server, per AGENTS.md's existing policy):
//
//   CREATE TABLE runs (
//     run_id TEXT PRIMARY KEY, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
//     niches JSONB, raw_hit_count INT, candidate_count INT,
//     incomplete_run BOOLEAN, incomplete_reasons JSONB, dropped_by_hard_filter_count INT
//   );
//   CREATE TABLE creators (
//     creator_id TEXT PRIMARY KEY, handle_or_name TEXT, platform TEXT,
//     first_seen_run_id TEXT REFERENCES runs(run_id), last_seen_run_id TEXT REFERENCES runs(run_id),
//     status TEXT CHECK (status IN ('new','reviewed','contacted','declined','converted')),
//     status_updated_at TIMESTAMPTZ, status_note TEXT
//   );
//   CREATE TABLE creator_scan_results (
//     id SERIAL PRIMARY KEY, run_id TEXT REFERENCES runs(run_id),
//     creator_id TEXT REFERENCES creators(creator_id), score NUMERIC,
//     estimated_followers TEXT, contact_method TEXT, evidence_url TEXT, seen_at TIMESTAMPTZ
//   );
//
// data/db/creators.json's per-creator `scan_history` array IS creator_scan_results, denormalized
// into the parent record — the migration is a straight unnest, no redesign needed.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const DB_DIR = "data/db";
const RUNS_LOG = path.join(DB_DIR, "runs.jsonl");
const CREATORS_FILE = path.join(DB_DIR, "creators.json");

export type CreatorStatus = "new" | "reviewed" | "contacted" | "declined" | "converted";

export interface RunRecord {
  run_id: string;
  started_at: string;
  finished_at: string;
  niches: string[];
  raw_hit_count: number;
  candidate_count: number;
  incomplete_run: boolean;
  incomplete_reasons: string[];
  dropped_by_hard_filter_count: number;
}

export interface ScanHistoryEntry {
  run_id: string;
  seen_at: string;
  score: number;
  estimated_followers: string;
  contact_method: string;
  evidence_url: string;
}

export interface CreatorRecord {
  creator_id: string;
  handle_or_name: string;
  platform: string;
  niche: string;
  first_seen_run_id: string;
  last_seen_run_id: string;
  last_seen_at: string;
  last_score: number;
  status: CreatorStatus;
  status_updated_at: string;
  status_note: string;
  scan_history: ScanHistoryEntry[];
}

type CreatorsFile = Record<string, CreatorRecord>;

const MAX_HISTORY_PER_CREATOR = 20;

function loadCreators(): CreatorsFile {
  if (!existsSync(CREATORS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CREATORS_FILE, "utf-8")) as CreatorsFile;
  } catch (err) {
    console.error(`==> [registry] ${CREATORS_FILE} corrupt, starting fresh:`, (err as Error).message);
    return {};
  }
}

export function appendRun(run: RunRecord): void {
  mkdirSync(DB_DIR, { recursive: true });
  appendFileSync(RUNS_LOG, JSON.stringify(run) + "\n");
}

export function loadRuns(limit?: number): RunRecord[] {
  if (!existsSync(RUNS_LOG)) return [];
  const lines = readFileSync(RUNS_LOG, "utf-8").trim().split("\n").filter(Boolean);
  const runs = lines.map((l) => JSON.parse(l) as RunRecord).reverse(); // newest first
  return limit ? runs.slice(0, limit) : runs;
}

// Upserts every candidate from a completed run into the creator registry. New creators get
// status "new"; existing creators keep their current status (a human already reviewed them —
// re-appearing in a later scan should never silently reset that) and just get a fresh
// scan_history entry + updated last_seen fields.
export function upsertCreators(runId: string, candidates: { channel_id?: string; evidence_url: string; handle_or_name: string; platform: string; niche: string; score: number; estimated_followers: string; contact_method: string }[]): { newCount: number; updatedCount: number } {
  const creators = loadCreators();
  const now = new Date().toISOString();
  let newCount = 0;
  let updatedCount = 0;

  for (const c of candidates) {
    const creatorId = c.channel_id && c.channel_id.length > 0 ? c.channel_id : `url:${c.evidence_url}`;
    const historyEntry: ScanHistoryEntry = {
      run_id: runId,
      seen_at: now,
      score: c.score,
      estimated_followers: c.estimated_followers,
      contact_method: c.contact_method,
      evidence_url: c.evidence_url,
    };

    const existing = creators[creatorId];
    if (!existing) {
      creators[creatorId] = {
        creator_id: creatorId,
        handle_or_name: c.handle_or_name,
        platform: c.platform,
        niche: c.niche,
        first_seen_run_id: runId,
        last_seen_run_id: runId,
        last_seen_at: now,
        last_score: c.score,
        status: "new",
        status_updated_at: now,
        status_note: "",
        scan_history: [historyEntry],
      };
      newCount++;
    } else {
      existing.last_seen_run_id = runId;
      existing.last_seen_at = now;
      existing.last_score = c.score;
      existing.scan_history = [historyEntry, ...existing.scan_history].slice(0, MAX_HISTORY_PER_CREATOR);
      updatedCount++;
      // status is intentionally NOT touched here — see comment above.
    }
  }

  mkdirSync(DB_DIR, { recursive: true });
  writeFileSync(CREATORS_FILE, JSON.stringify(creators, null, 2));
  return { newCount, updatedCount };
}

export function loadCreatorsList(): CreatorRecord[] {
  return Object.values(loadCreators());
}

// Manual status transition — called from the review one-pager's workflow (or by hand editing
// the JSON, which is a valid escape hatch at this file-based stage). Not wired into a UI mutation
// endpoint yet (no server exists) — documented here as the intended API shape for when one does.
export function setCreatorStatus(creatorId: string, status: CreatorStatus, note = ""): boolean {
  const creators = loadCreators();
  const c = creators[creatorId];
  if (!c) return false;
  c.status = status;
  c.status_updated_at = new Date().toISOString();
  if (note) c.status_note = note;
  writeFileSync(CREATORS_FILE, JSON.stringify(creators, null, 2));
  return true;
}
