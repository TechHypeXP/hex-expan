// registry_report.ts — internal one-pager: what's new since the last scan, what's already been
// reviewed/contacted/declined/converted, and the run history. Reads data/db/{runs.jsonl,
// creators.json} (written by registry.ts via creator_scan.ts) — does not fire any API calls.
// run via `pnpm registry-report`
import { writeFileSync, mkdirSync } from "node:fs";
import { loadCreatorsList, loadRuns } from "./registry.ts";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// All timestamps are stored as real UTC ISO strings (Date.toISOString() at the moment each
// event happened — never fabricated, see registry.ts). Display in Cairo local time (CAI) since
// that's the user's actual timezone, alongside the raw UTC value for anyone reading this from
// elsewhere. Uses the IANA Africa/Cairo zone via Intl rather than a hardcoded UTC+2/+3 offset,
// so it stays correct through Egypt's DST rule changes automatically.
const CAI_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
  hour12: false,
});
function formatCai(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso); // fallback path — escape, never trust raw input into HTML
  return CAI_FORMAT.format(d).replace(",", "") + " CAI";
}
function formatBoth(iso: string): string {
  if (!iso) return "";
  return `${formatCai(iso)} <span class="dim">(${esc(iso.slice(0, 16).replace("T", " "))} UTC)</span>`;
}

function main() {
  const creators = loadCreatorsList().sort((a, b) => b.last_score - a.last_score);
  const runs = loadRuns(20);

  const byStatus = {
    new: creators.filter((c) => c.status === "new"),
    reviewed: creators.filter((c) => c.status === "reviewed"),
    contacted: creators.filter((c) => c.status === "contacted"),
    declined: creators.filter((c) => c.status === "declined"),
    converted: creators.filter((c) => c.status === "converted"),
  };

  const creatorRow = (c: (typeof creators)[number]) => `<tr>
<td><strong>${esc(c.handle_or_name)}</strong></td><td>${esc(c.platform)}</td><td>${esc(c.niche)}</td>
<td class="score">${c.last_score}</td><td>${formatBoth(c.last_seen_at)}</td>
<td>${esc(c.scan_history.length)} scan(s)</td><td>${esc(c.status_note)}</td>
<td><a href="${esc(c.scan_history[0]?.evidence_url ?? "")}">source</a></td>
</tr>`;

  const runRow = (r: (typeof runs)[number]) => `<tr>
<td>${formatCai(r.started_at)}</td><td>${esc(r.niches.join(", "))}</td><td>${r.raw_hit_count}</td><td>${r.candidate_count}</td>
<td>${r.incomplete_run ? `⚠️ <span class="dim">${esc(r.incomplete_reasons.join("; "))}</span>` : "✅"}</td>
<td>${r.dropped_by_hard_filter_count}</td>
</tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Creator Registry</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
h1{font-size:22px}h2{font-size:17px;margin-top:40px;display:flex;align-items:center;gap:8px}
.count{background:#238636;color:#fff;border-radius:10px;padding:1px 8px;font-size:12px}
.meta{color:#8b949e;font-size:13px;margin-bottom:24px}
table{border-collapse:collapse;width:100%}th{background:#161b22;text-align:left}
th,td{padding:8px 11px;border:1px solid #30363d;font-size:13px;vertical-align:top}
tr:hover td{background:#161b22}.score{color:#3fb950;font-weight:700}.dim{color:#8b949e;font-size:11px}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.empty{color:#8b949e;font-style:italic;padding:12px 0}
</style></head><body>
<h1>Creator Registry — what's new, what's been worked</h1>
<div class="meta">Generated ${formatCai(new Date().toISOString())} · ${creators.length} creators tracked across ${runs.length} logged run(s) · data/db/creators.json + data/db/runs.jsonl</div>

<h2>New — not yet reviewed <span class="count">${byStatus.new.length}</span></h2>
${byStatus.new.length ? `<table><thead><tr><th>Creator</th><th>Platform</th><th>Niche</th><th>Score</th><th>Last seen</th><th>History</th><th>Note</th><th>Evidence</th></tr></thead><tbody>${byStatus.new.map(creatorRow).join("")}</tbody></table>` : `<div class="empty">Nothing new.</div>`}

<h2>Reviewed <span class="count">${byStatus.reviewed.length}</span></h2>
${byStatus.reviewed.length ? `<table><thead><tr><th>Creator</th><th>Platform</th><th>Niche</th><th>Score</th><th>Last seen</th><th>History</th><th>Note</th><th>Evidence</th></tr></thead><tbody>${byStatus.reviewed.map(creatorRow).join("")}</tbody></table>` : `<div class="empty">None yet.</div>`}

<h2>Contacted <span class="count">${byStatus.contacted.length}</span></h2>
${byStatus.contacted.length ? `<table><thead><tr><th>Creator</th><th>Platform</th><th>Niche</th><th>Score</th><th>Last seen</th><th>History</th><th>Note</th><th>Evidence</th></tr></thead><tbody>${byStatus.contacted.map(creatorRow).join("")}</tbody></table>` : `<div class="empty">None yet.</div>`}

<h2>Converted <span class="count">${byStatus.converted.length}</span></h2>
${byStatus.converted.length ? `<table><thead><tr><th>Creator</th><th>Platform</th><th>Niche</th><th>Score</th><th>Last seen</th><th>History</th><th>Note</th><th>Evidence</th></tr></thead><tbody>${byStatus.converted.map(creatorRow).join("")}</tbody></table>` : `<div class="empty">None yet — this is the metric that matters most.</div>`}

<h2>Declined <span class="count">${byStatus.declined.length}</span></h2>
${byStatus.declined.length ? `<table><thead><tr><th>Creator</th><th>Platform</th><th>Niche</th><th>Score</th><th>Last seen</th><th>History</th><th>Note</th><th>Evidence</th></tr></thead><tbody>${byStatus.declined.map(creatorRow).join("")}</tbody></table>` : `<div class="empty">None yet.</div>`}

<h2>Run history (last ${runs.length})</h2>
<table><thead><tr><th>Started (CAI)</th><th>Niches</th><th>Raw hits</th><th>Candidates</th><th>Complete?</th><th>Dropped by hard filter</th></tr></thead><tbody>${runs.map(runRow).join("")}</tbody></table>

<p class="dim" style="margin-top:32px">To change a creator's status: edit their entry's "status" field directly in data/db/creators.json (valid values: new, reviewed, contacted, declined, converted), or use setCreatorStatus() from registry.ts. No mutation UI yet — this page is read-only.</p>
</body></html>`;

  mkdirSync("data/db", { recursive: true });
  writeFileSync("data/db/registry_report.html", html);
  console.log(`==> data/db/registry_report.html written — ${creators.length} creators (${byStatus.new.length} new, ${byStatus.converted.length} converted)`);
}

main();
