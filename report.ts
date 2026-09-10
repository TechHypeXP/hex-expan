import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

interface Cand {
  title: string;
  format?: string;
  price?: number;
  domain?: number;
  avatar?: string;
  hook?: string;
  driver?: string;
  lever?: string;
  build_hrs?: number;
  evidence_url?: string;
  source?: string;
  P: number; E: number; T: number; F: number; S: number;
  saturation_unverified?: boolean;
  vs: number;
}

const args = process.argv.slice(2).filter((a) => a !== "--");
const argFile = args.find((a) => !a.startsWith("--"));

function latestScored(): string {
  if (argFile) return argFile;
  const dirs = readdirSync("data").filter((d) => d.startsWith("scored_")).sort();
  if (dirs.length === 0) throw new Error("no data/scored_*/scored.json — run pnpm score first");
  return `data/${dirs[dirs.length - 1]}/scored.json`;
}

const file = latestScored();
const data = JSON.parse(readFileSync(file, "utf-8"));
const cands: Cand[] = data.candidates;
const runId = data.meta.run_id;
const outDir = `data/report_${new Date().toISOString().replace(/[:.]/g, "-")}`;
mkdirSync(outDir, { recursive: true });

const top10 = cands.slice(0, 10);
const domainNames: Record<number, string> = {
  1: "Wealth & Micro-Cashflow",
  2: "Body, Mind & Aesthetic",
  3: "Career, Freelance & Agency",
  4: "Productivity & Digital Sanity",
  5: "Relationships & Niche Hobbies",
};

const fmtPrice = (c: Cand) => (typeof c.price === "number" ? `$${c.price}` : "—");

function card(c: Cand, rank: number): string {
  const who = c.avatar ?? "—";
  const what = `${c.format ?? "—"} · ${fmtPrice(c)} · ${domainNames[c.domain ?? 0] ?? "—"}`;
  const whyNow = c.source === "serpapi" ? "Riding a live Google Trends breakout" : `Signal from ${c.source ?? "harvest"}`;
  const how = `${c.build_hrs ?? "?"}h build · ${c.format === "Web Micro-Calculator" ? "static page, zero support" : "digital delivery, 100% automated"}`;
  const howMuch = typeof c.price === "number" ? `${Math.ceil(3000 / c.price)} sales/mo → $3,000/mo` : "—";
  const loud = c.driver === "Status" ? "Flex-screenshot bait: dashboard/results visuals" : c.driver === "Survival" ? "Urgency hook: 'stop the bleed before Monday'" : c.driver === "Autonomy" ? "Freedom hook: 'cancel your subscriptions'" : "Belonging hook: 'join the people who know'";
  const sat = c.saturation_unverified ? `${c.S} (unverified)` : `${c.S} — ${c.S <= 2 ? "open lane" : c.S <= 5 ? "contested" : "red ocean"}`;
  return `### ${rank}. ${c.title} — V_s ${c.vs.toFixed(1)}
- **WHO:** ${who}
- **WHAT:** ${what}
- **WHY (pain):** ${c.hook ?? "—"} · [evidence](${c.evidence_url ?? "#"}) (${c.source ?? "-"})
- **WHY NOW:** ${whyNow}
- **HOW:** ${how}
- **HOW MUCH:** ${fmtPrice(c)} → ${howMuch}
- **HOW LOUD:** ${loud}
- **V_s block:** P:${c.P} E:${c.E} T:${c.T} F:${c.F} S:${sat} = **${c.vs.toFixed(1)}** (P·.25+E·.20+T·.20+F·.15−S·.20)`;
}

const md = `# Hex-Expan Product Intelligence Report
Run: \`${runId}\` · Candidates: ${cands.length} · Formula: \`V_s = P·0.25 + E·0.20 + T·0.20 + F·0.15 − S·0.20\` (range −20..40)

## Top 10 Triage Table
| # | Product | Format | Price | Buyer Avatar | Hook | V_s | S | Build |
|---|---|---|---|---|---|---|---|---|
${top10.map((c, i) => `| ${i + 1} | ${c.title} | ${c.format} | ${fmtPrice(c)} | ${c.avatar} | ${c.hook} | **${c.vs.toFixed(1)}** | ${c.S} | ${c.build_hrs}h |`).join("\n")}

## Top 10 Intelligence Cards (5W+H)
${top10.map((c, i) => card(c, i + 1)).join("\n\n")}
---
*V_s computed against live SerpAPI ad-density + organic counts. Educational estimates, not advice.*
`;

writeFileSync(path.join(outDir, "report.md"), md);

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rows = top10.map((c, i) => `<tr>
<td>${i + 1}</td><td><strong>${esc(c.title)}</strong></td><td>${esc(c.format)}</td><td>${fmtPrice(c)}</td>
<td>${esc(c.avatar)}</td><td>${esc(c.hook)}</td><td class="vs">${c.vs.toFixed(1)}</td><td>${c.S}</td><td>${c.build_hrs}h</td></tr>`).join("");

const cardsHtml = top10.map((c, i) => `<div class="card">
<h3>${i + 1}. ${esc(c.title)} <span class="badge vs">V_s ${c.vs.toFixed(1)}</span></h3>
<div class="grid">
<div><b>WHO</b><span>${esc(c.avatar)}</span></div>
<div><b>WHAT</b><span>${esc(c.format)} · ${fmtPrice(c)} · ${esc(domainNames[c.domain ?? 0] ?? "")}</span></div>
<div><b>WHY (pain)</b><span>${esc(c.hook)} — <a href="${esc(c.evidence_url)}">evidence</a> (${esc(c.source)})</span></div>
<div><b>WHY NOW</b><span>${c.source === "serpapi" ? "Live Google Trends breakout" : `Signal via ${esc(c.source)}`}</span></div>
<div><b>HOW</b><span>${c.build_hrs}h build · 100% automated fulfillment</span></div>
<div><b>HOW MUCH</b><span>${fmtPrice(c)} → ${Math.ceil(3000 / (c.price || 1))} sales/mo = $3,000/mo</span></div>
<div><b>HOW LOUD</b><span>${c.driver === "Status" ? "Flex-screenshot bait" : c.driver === "Survival" ? "Urgency: stop-the-bleed hook" : c.driver === "Autonomy" ? "Freedom: cancel-subscriptions hook" : "Belonging: insider-knowledge hook"}</span></div>
<div><b>V_s BLOCK</b><span>P:${c.P} E:${c.E} T:${c.T} F:${c.F} S:${c.S}${c.saturation_unverified ? " (unverified)" : ""} → <strong>${c.vs.toFixed(1)}</strong></span></div>
</div></div>`).join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Hex-Expan Report ${esc(runId)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
h1{font-size:22px}h3{margin:4px 0 10px}.meta{color:#8b949e;font-size:13px;margin-bottom:24px}
table{border-collapse:collapse;width:100%;margin:16px 0 40px}th{cursor:pointer;user-select:none;background:#161b22;text-align:left}th,td{padding:9px 12px;border:1px solid #30363d;font-size:13px}
tr:hover td{background:#161b22}.vs{color:#3fb950;font-weight:700}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px 20px;margin:0 0 16px;max-width:960px}
.grid{display:grid;grid-template-columns:130px 1fr;gap:6px 12px;font-size:13px}
.grid b{color:#58a6ff}.badge{background:#1f6feb22;color:#58a6ff;border:1px solid #58a6ff55;border-radius:99px;padding:2px 10px;font-size:12px;vertical-align:middle}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body>
<h1>Hex-Expan · Product Intelligence</h1>
<div class="meta">run ${esc(runId)} · ${cands.length} candidates · formula V_s = P·.25 + E·.20 + T·.20 + F·.15 − S·.20 (−20..40) · click headers to sort</div>
<table id="t"><thead><tr><th>#</th><th>Product</th><th>Format</th><th>Price</th><th>Buyer Avatar</th><th>Hook</th><th>V_s</th><th>S</th><th>Build</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Top 10 Intelligence Cards</h2>
${cardsHtml}
<script>
document.querySelectorAll("#t th").forEach((th,i)=>th.addEventListener("click",()=>{
const tb=document.querySelector("#t tbody");const rows=[...tb.rows];const num=i===0||i===3||i===6||i===7||i===8;
rows.sort((a,b)=>{const x=a.cells[i].innerText,y=b.cells[i].innerText;return num?parseFloat(x)-parseFloat(y):x.localeCompare(y)});
tb.append(...rows)}));
</script></body></html>`;

writeFileSync(path.join(outDir, "report.html"), html);
console.log(`==> Report: ${outDir}/report.md`);
console.log(`==> Report: ${outDir}/report.html (self-contained, open in browser)`);
