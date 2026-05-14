# Orchestrator Spec

The orchestrator is the agent that drives Phases 1 through 8 sequentially. It runs in the **main conversation context** of Claude Code — it is not a sub-agent. It dispatches one specialist sub-agent per phase, waits for completion, validates exit tests, then proceeds.

## Hard rules

1. **Sequential tool execution only.** The user has a global safety protocol (`CLAUDE.md`) that requires one tool call at a time, waiting for each `tool_result` before the next. The orchestrator NEVER spawns parallel agents and NEVER batches independent tool calls.
2. **Never use `model: haiku`** when spawning agents. Inherit parent model (Opus) or use `sonnet`/`opus`.
3. **One phase at a time.** No look-ahead, no partial Phase N+1 work while Phase N is still running.
4. **Exit tests must pass.** If a phase's exit tests fail, dispatch the `debugger` agent with the failing test output before continuing to the next phase. Do not skip.

## Flow

```
For phase in [01, 02, 03, 04, 05, 06, 07, 08]:
  1. Read plan/PHASES/PHASE-XX-*.md
  2. Append a row to plan/PROGRESS.md: status=in_progress, started=<ISO timestamp>
  3. Spawn the named specialist agent (Agent tool) with:
       - subagent_type: <as named in the phase MD>
       - prompt: the phase MD contents + standard preamble (see below)
  4. Wait for the agent to return.
  5. Run the phase's exit tests (typically: pnpm typecheck, pnpm lint, pnpm test, pnpm build).
  6. If exit tests pass:
       - Update plan/PROGRESS.md: status=completed, completed=<ISO timestamp>
       - Continue to next phase.
     Else:
       - Spawn debugger agent with the failing output.
       - On debugger completion, re-run exit tests.
       - If still failing after one debugger pass, write a "STALL" row to plan/PROGRESS.md and halt for user direction.
  7. Commit the phase's work with a single conventional commit: `feat(phase-XX): <title>`.

On all phases complete:
  - Spawn herald for the Phase 8 release dry-run.
  - Report final status to the user.
```

## Standard preamble for every phase agent prompt

Every dispatched specialist receives, prepended to its phase MD:

> You are executing **Phase XX** of a multi-phase plan to extract a Saudi ZATCA Phase 2 e-invoicing helper from `/Users/ameensaeed/Documents/Node/rwiqha-backend` into the open-source package `@dokhna-tech/zatca`. The full master plan is at `/Users/ameensaeed/.claude/plans/we-ve-been-trying-to-twinkly-pascal.md` — read it first for context.
>
> Working directory: `/Users/ameensaeed/Documents/Node/dokhna-tech-zatca-phase-2`.
>
> Hard rules:
> - Sequential tool execution only. One tool_use, wait for its tool_result, then continue.
> - Never use `model: haiku` for sub-agents.
> - Do not modify `/Users/ameensaeed/Documents/Node/rwiqha-backend/` — it is read-only reference.
> - On any unexplained pre-flight or build failure, pause and ask rather than auto-retry.
>
> Your phase-specific work is below.

## Agent assignments (from the master plan)

| Phase | Agent |
|-------|-------|
| 01 | typescript-pro |
| 02 | backend-developer |
| 03 | backend-developer |
| 04 | backend-developer |
| 05 | architect (design pass) → typescript-pro (interface) → backend-developer (adapters) |
| 06 | backend-developer |
| 07 | typescript-pro (write) → architect-reviewer (review pass) |
| 08 | architect-reviewer (audit pass) → herald (release prep) |

## Checkpoint behaviour

- **After Phase 0:** hard checkpoint (already passed). User must say "go" before Phase 1 begins.
- **After every other phase:** no hard checkpoint by default. PROGRESS.md row is updated and orchestrator continues. Observer surfaces any stall.
- **On STALL:** orchestrator halts and waits for user input.

## How to begin

The orchestrator is the main conversation agent. To begin Phase 1, the orchestrator:

1. Confirms user has said "go" after Phase 0 review.
2. Starts the Observer via the `/loop` skill: `/loop 2m <observer prompt from OBSERVER.md>`.
3. Reads `plan/PHASES/PHASE-01-types.md`.
4. Spawns `typescript-pro` with the standard preamble + Phase 1 content.
5. Awaits return, runs exit tests, updates PROGRESS.md, commits, advances.
