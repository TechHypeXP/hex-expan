// getinsight_id_br.ts — Decodo residential proxy fetch + cheerio parse (no CDP), robots.txt gate.
// NOTE: ToS review found "may not copy, modify, or redistribute platform content" (§4).
// Prefer the official Agent Connector (https://www.ideabrowser.com/agents) over scraping.
// Run: pnpm scrape
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const execFileP = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TARGET_URL = "https://www.ideabrowser.com/database";
const OUTPUT_FILE = path.join(ROOT, "ideabrowser_vault.json");

interface ExtractedIdea {
  id: string;
  title: string;
  category: string;
  description: string;
  source_url: string;
  timestamp: string;
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const file = path.join(ROOT, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1]) env[m[1]] = m[2];
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !(k in env)) env[k] = v;
  }
  return env;
}

async function robotsGate(): Promise<void> {
  const res = await fetch("https://www.ideabrowser.com/robots.txt");
  if (!res.ok) {
    console.log("==> robots.txt unavailable — defaulting to allow");
    return;
  }
  const txt = await res.text();
  const lines = txt.split("\n").map((l) => l.trim());
  let inStar = false;
  for (const line of lines) {
    if (/^user-agent:/i.test(line)) inStar = line.split(":")[1]?.trim() === "*";
    else if (inStar && /^disallow:/i.test(line)) {
      const rule = line.slice(line.indexOf(":") + 1).trim();
      if (rule === "/" || (rule.length > 1 && TARGET_URL.slice(24).startsWith(rule)) || TARGET_URL.endsWith(rule)) {
        throw new Error(`robots.txt forbids scraping ${TARGET_URL} (rule: ${rule})`);
      }
    }
  }
  console.log("==> robots.txt gate passed");
}

async function fetchViaProxy(env: Record<string, string>): Promise<string> {
  const user = env.DECODO_RESIDENTIAL_USER;
  const pass = env.DECODO_RESIDENTIAL_PASS;
  const gateway = env.DECODO_RESIDENTIAL_GATEWAY;
  if (!user || !pass || !gateway) throw new Error("Decodo residential proxy creds missing");

  const attempts = 3;
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    console.log(`==> Attempt ${i}/${attempts} via Decodo residential (${gateway})...`);
    try {
      const { stdout } = await execFileP("curl", [
        "-s", "-k", "--max-time", "60",
        "--proxy", `https://${gateway}`,
        "--proxy-user", `${user}:${pass}`,
        "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "-H", "Accept: text/html,application/xhtml+xml",
        "-H", "Accept-Language: en-US,en;q=0.9",
        TARGET_URL,
      ], { maxBuffer: 128 * 1024 * 1024, timeout: 70000 });
      if (stdout && stdout.length >= 500) return stdout;
      lastErr = new Error(`short response (${stdout?.length ?? 0} bytes)`);
      console.log(`==> attempt ${i}: ${String((lastErr as Error).message)}`);
    } catch (err) {
      lastErr = err;
      console.log(`==> attempt ${i}: ${String((err as Error).message).split("\n")[0].slice(0, 120)}`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 5000));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function extractIdeas(html: string): { ideas: ExtractedIdea[]; source: string } {
  const ts = new Date().toISOString();
  const $ = cheerio.load(html);

  const nextDataRaw = $("script#__NEXT_DATA__").html();
  if (nextDataRaw) {
    try {
      const nextData = JSON.parse(nextDataRaw);
      const raw = nextData?.props?.pageProps?.ideas ?? nextData?.props?.pageProps?.ideasList ?? [];
      if (Array.isArray(raw) && raw.length > 0) {
        return {
          source: "__NEXT_DATA__",
          ideas: raw.map((item: any, idx: number) => ({
            id: String(item.id ?? `idea-${idx}`),
            title: item.title ?? item.name ?? "Untitled Idea",
            category: item.category ?? item.tag ?? "General",
            description: item.description ?? item.problem ?? item.summary ?? "",
            source_url: item.slug ? `https://www.ideabrowser.com/idea/${item.slug}` : TARGET_URL,
            timestamp: ts,
          })),
        };
      }
    } catch {}
  }

  const ideas: ExtractedIdea[] = [];
  let idx = 0;
  $("a[href*='/idea/']").each((_, el) => {
    const node = $(el);
    const title = (node.find("h2, h3, h4").first().text() || node.text()).trim().slice(0, 200);
    if (!title || title.length < 4) return;
    const desc = node.find("p").first().text().trim();
    const category = node.find(".rounded-full, [class*='badge'], [class*='tag']").first().text().trim() || "Opportunity";
    const href = node.attr("href") ?? "";
    ideas.push({
      id: `dom-${idx++}`,
      title,
      category,
      description: desc || "No description provided",
      source_url: href.startsWith("http") ? href : `https://www.ideabrowser.com${href}`,
      timestamp: ts,
    });
  });
  return { source: "cheerio-dom", ideas };
}

async function main() {
  await robotsGate();
  const env = loadEnv();
  const html = await fetchViaProxy(env);
  if (!html || html.length < 500) {
    throw new Error(`target returned ${html?.length ?? 0} bytes — likely blocked`);
  }
  const { ideas, source } = extractIdeas(html);
  console.log(`==> Parser: ${source}, ideas extracted: ${ideas.length}`);
  writeFileSync(OUTPUT_FILE, JSON.stringify(ideas, null, 2), "utf-8");
  console.log(`==> Vault saved: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("==> Scraping pipeline failed:", err?.message || err);
  process.exit(1);
});
