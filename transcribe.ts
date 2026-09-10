import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ override: true, path: path.join(ROOT, ".env") });
const HOME = process.env.HOME ?? "";
const FFMPEG = path.join(HOME, ".local/bin/ffmpeg");
const FFPROBE = path.join(HOME, ".local/bin/ffprobe");
const DL = path.join(ROOT, "downloads");
const args = process.argv.slice(2).filter((a) => a !== "--");
const fileArg = args.find((a) => a.startsWith("--file="));
const PART = fileArg
  ? fileArg.split("=").slice(1).join("=")
  : existsSync(path.join(DL, "gadzhi_live_video.mp4"))
    ? path.join(DL, "gadzhi_live_video.mp4")
    : path.join(DL, "gadzhi_live_video.f140.mp4.part");
const BASE = path.basename(PART).replace(/\.(mp4|part|m4a).*$/, "");
const STATE = path.join(DL, `transcribe_state_${BASE}.json`);
const OUT = path.join(DL, `transcript_${BASE}.md`);
const DONE = path.join(DL, `DONE_${BASE}`);
const MODEL = process.env.WHISPER_MODEL || "openai/whisper-large-v3-turbo:nitro";
const CHUNK = Number(args.find((a) => a.startsWith("--chunk="))?.split("=")[1]) || 600;
const MARGIN = 90;

function durationOf(file: string): number {
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 60000 }).toString().trim();
      last = Number(out) || 0;
      if (last > 0) return last;
    } catch {
      last = 0;
    }
    execFileSync("sleep", ["3"]);
  }
  throw new Error(`ffprobe could not read duration of ${file} after 3 tries`);
}

function makeChunk(start: number, dur: number, out: string): void {
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-ss", String(start), "-i", PART, "-t", String(dur), "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", out], { timeout: 180000 });
}

async function transcribeFile(file: string): Promise<{ text: string; segments?: { start: number; end: number; text: string }[] }> {
  const b64 = readFileSync(file).toString("base64");
  const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input_audio: { data: b64, format: "mp3" },
      response_format: "verbose_json",
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`transcribe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { text?: string; segments?: { start: number; end: number; text: string }[] };
  return { text: j.text ?? "", segments: j.segments };
}

const ts = (sec: number): string => {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  return `${h}:${m}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const watch = process.argv.includes("--watch");
  console.log(`==> source: ${PART}`);
  if (!existsSync(PART)) throw new Error(`input file not found: ${PART}`);
  if (!existsSync(STATE)) writeFileSync(STATE, JSON.stringify({ lastSec: 0 }));
  const state = JSON.parse(readFileSync(STATE, "utf-8")) as { lastSec: number };
  if (!existsSync(OUT)) writeFileSync(OUT, `# Gadzhi Live Transcript\n\n`);

  let finished = false;
  while (!finished) {
    const dur = durationOf(PART);
    const target = existsSync(DONE) ? dur : Math.max(0, dur - MARGIN);
    while (state.lastSec + CHUNK <= target) {
      const start = state.lastSec;
        const tmp = path.join(DL, `.chunk_${start}_${process.pid}.mp3`);
      console.log(`[${ts(start)}] chunking + transcribing...`);
      try {
        makeChunk(start, CHUNK, tmp);
        const r = await transcribeFile(tmp);
        const block =
          r.segments && r.segments.length > 0
            ? r.segments.map((s) => `- [${ts(start + s.start)}] ${s.text.trim()}`).join("\n")
            : r.text.trim();
        appendFileSync(OUT, `\n## [${ts(start)}]\n${block}\n`);
        state.lastSec = start + CHUNK;
        writeFileSync(STATE, JSON.stringify(state));
        console.log(`[${ts(start)}] transcribed, ${r.text.length} chars, ${r.segments?.length ?? 0} segments`);
      } catch (err) {
        console.error(`chunk@${start} failed: ${String((err as Error).message).slice(0, 150)}`);
        await sleep(30000);
      } finally {
        if (existsSync(tmp)) execFileSync("rm", ["-f", tmp]);
      }
    }
    if (!watch) break;
    if (existsSync(DONE)) {
      const finalDur = durationOf(PART);
      if (finalDur - state.lastSec > 5) {
        const tmp = path.join(DL, `.chunk_final_${process.pid}.mp3`);
        try {
          makeChunk(state.lastSec, finalDur - state.lastSec, tmp);
          const r = await transcribeFile(tmp);
          const block =
            r.segments && r.segments.length > 0
              ? r.segments.map((s) => `- [${ts(state.lastSec + s.start)}] ${s.text.trim()}`).join("\n")
              : r.text.trim();
          appendFileSync(OUT, `\n## [${ts(state.lastSec)}]\n${block}\n`);
          state.lastSec = finalDur;
          writeFileSync(STATE, JSON.stringify(state));
        } catch (err) {
          console.error(`final chunk failed: ${String((err as Error).message).slice(0, 150)}`);
        }
      }
      console.log("stream ended, transcript complete");
      finished = true;
      break;
    }
    await sleep(10 * 60 * 1000);
  }
}

main().catch((err) => {
  console.error("transcriber failed:", err?.message || err);
  process.exit(1);
});
