# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` in this directory — it is the authoritative, actively-maintained source of commands, architecture, data format policy, and hard-won operational quirks for this repo. Read it in full before making changes. `data/intel/engine_thesis_handover.md` is a companion handover doc (mission, pending decisions, failure folklore) — read both before touching the pipeline.

A few things worth restating because they are easy to violate accidentally:

- No git repo here — do not `git init` without asking first, even if another summary or session claims one exists.
- Pipeline order is fixed: `harvest` → GLM generates `candidates.json` → `score`. Never reorder or skip.
- `.env` holds live API keys — never echo or paste key values back into chat.
- Files referenced in other summaries/handoffs are not guaranteed to exist — verify with `ls`/`grep` before relying on them (e.g. no `phase4_creator_match.ts` exists as of this writing; it's a proposal, not shipped code).
