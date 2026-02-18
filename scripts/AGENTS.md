# Agent Guidelines

## Core Principles

- Always prefer simplicity over pathological correctness. YAGNI, KISS, DRY. No backward-compat shims or fallback paths unless they come free without adding cyclomatic complexity.
- Keep this file under 20-30 lines of instructions. Every line competes for the agent's limited context budget (~150-200 total).

---

## Core Policy

### Directory Responsibilities
- `src/prompts/`: static Claude prompt markdown only. No runtime logic.
- `src/core/`: app logic and orchestration without direct side effects.
- `src/adapters/`: Discord/Claude CLI/fs/cron implementations and side effects.
- `test/`: unit + integration tests (no real-network E2E in default workflow).

### File Granularity Rules
- Prefer function-focused files (e.g. `conversation-service.ts`, `schedule-service.ts`, `message-format.ts`).
- Target ~100-250 lines/file; review for split when a file exceeds ~300 lines.
- Avoid vague buckets: `utils.ts`, `helpers.ts`, `misc.ts`, `manager.ts`, `text.ts`, `usecases.ts`.

### Type-First Design Rules
- Validate all external inputs with `zod` (`.env`, `settings.bot.json`, Discord payloads, Claude JSON).
- No `any`; narrow `unknown` only after validation.
- Model failures as discriminated unions (`kind`) and use exhaustive `switch` + `assertNever`.
- Keep string literals constrained with typed constants; use branded IDs where practical.

### Testing Rules
- Use `bun test` as the default runner.
- Keep `test/` as a mirror of `src/` (`test/core/*` for `src/core/*`, `test/adapters/*` for `src/adapters/*`).
- Minimum coverage focus: `message-format`, `config` validation, `claude-run-queue`, `conversation-service`, `schedule-service`.
- For every bug fix, add a failing test first, then implement the fix.

### Naming Rules
- Use capability-based names (`*-service.ts`, `*-adapter.ts`, `*-queue.ts`).
- Keep prompt filenames kebab-case under `src/prompts/`.

### Do / Don't
- Do keep side effects in adapters and keep core deterministic/testable.
- Do return typed results from core/application logic.
- Don't call `Bun.spawn`, `fs`, or `discord.js` directly from `src/core/`.
- Don't pass unvalidated JSON or environment values into business logic.

---

## Maintenance Notes

<!-- This section is permanent. Do not delete. -->

Keep this file lean and current:

1. Remove placeholder sections (sections still containing `[To be determined]` or `[Add your ... here]`) once you fill them in
2. Review regularly - stale instructions poison the agent's context
3. CRITICAL: Keep total under 20-30 lines - move detailed docs to separate files and reference them
4. Update commands immediately when workflows change
5. Rewrite Architecture section when major architectural changes occur
6. Delete anything the agent can infer from your code

Remember: Coding agents learn from your actual code. Only document what's truly non-obvious or critically important.
