# Observer Spec

The observer is a read-only, periodic health-check that fires every 2 minutes during active phase execution. It does not modify code, does not spawn other agents, and does not run tests. It surfaces stalls so the orchestrator (and the user) can intervene before silent failures waste time.

## Activation

Started by the orchestrator using the `/loop` skill:

```
/loop 2m <observer prompt below>
```

The observer is stopped when all phases complete or when the user explicitly halts the loop.

## What the observer does on each tick

For each tick the observer performs three cheap probes and appends a single line to `plan/observer.log`:

1. **Git working tree:** `git status --porcelain | wc -l` — number of changed/staged/untracked files.
2. **Workspace typecheck:** `pnpm -r typecheck --silent` — exit code only (do not capture stdout).
3. **Active phase MD mtime:** `stat -f %m plan/PHASES/PHASE-XX-*.md` — last-modified epoch for the row currently marked `in_progress` in `plan/PROGRESS.md`.

The log line format is:

```
<ISO timestamp> | phase=<XX> | porcelain=<N> | typecheck=<pass|fail> | mtime_age=<seconds>
```

## Stall detection

A stall is detected when **all three** of the following hold across **five consecutive ticks** (~10 minutes):

1. `porcelain` count has not changed.
2. `typecheck` exit status has not changed.
3. `mtime_age` keeps increasing (no edits to the active phase MD).

On stall detection, the observer appends a row to the **`## Stall warnings`** section of `plan/PROGRESS.md`:

```
- <ISO timestamp> — Phase XX stalled for >10 minutes; last activity at <ISO>; current porcelain=<N>; typecheck=<pass|fail>
```

The observer DOES NOT spawn agents, modify code, or restart anything. The stall row is the only side-effect.

## Stop conditions

- All 8 phases marked `completed` in `plan/PROGRESS.md`.
- User runs `/loop stop` or the equivalent.
- Repeated identical stalls (>3 in succession) — observer self-halts and writes a final "observer halted, recurring stall" line.

## Failure modes the observer cannot detect

- ZATCA sandbox throttling (looks like a long-running test, not a stall).
- Type errors hidden behind `@ts-expect-error`.
- Tests passing on wrong fixtures.

These belong to the orchestrator's exit tests, not the observer.

## Observer prompt (paste into `/loop 2m <prompt>`)

> You are the observer for the @dokhna-tach/zatca phase pipeline. Run three probes against `/Users/ameensaeed/Documents/Node/dokhna-tach-zatca-phase-2`:
> 1. `cd <workdir> && git status --porcelain | wc -l`
> 2. `cd <workdir> && pnpm -r typecheck --silent ; echo $?`
> 3. Find the row in `plan/PROGRESS.md` with status `in_progress`; locate the matching `plan/PHASES/PHASE-XX-*.md`; report its mtime.
> Append one line in the format described in `plan/OBSERVER.md` to `plan/observer.log`. If five consecutive ticks show no progress (porcelain unchanged, typecheck unchanged, mtime stale), append a stall row to `plan/PROGRESS.md` under `## Stall warnings`. Do not run tests. Do not modify source files. Do not spawn agents. Report only what you did this tick (≤80 words).
