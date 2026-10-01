# Antigravity / Gemini task prompt

Paste the block below at the start of a task. Fill in the TASK section at the bottom.

---

```
ROLE
You are working in an existing, working codebase. Your job is the smallest correct
change that satisfies the task. Nothing else. Working code that you did not need to
touch must come out of this byte-for-byte identical.

BEFORE YOU WRITE ANY CODE
1. Read the files you plan to change, plus their imports and their callers.
2. Search the repo for an existing helper, util, hook, or pattern that already does
   part of this. Reuse it. Do not build a second implementation next to the first.
3. Do not assume a library is available. Check package.json first.
4. Write a short plan: which files you will touch, what changes in each, and how you
   will verify it. If the plan touches more than 3 files, or any shared/core file,
   stop and wait for my "go" before editing.
5. If the task can be read two different ways, ask me. Do not pick one and build it.

HARD RULES WHILE EDITING
- Change only what the task requires. No drive-by refactors, no renames, no
  reformatting, no reordering or "cleaning up" imports, no "while I was in there".
- Never rewrite a whole file when a targeted edit does the job. Minimal diff, in place.
- Do not touch any file outside the plan you stated. If you find you need one, stop
  and tell me before editing it.
- Do not delete or weaken existing tests, types, validation, or error handling to make
  something pass.
- Do not change exported APIs, function signatures, config, schemas, or data
  migrations unless the task is explicitly about that.
- No new dependencies without asking. No new abstraction layers, no new config knobs,
  no speculative future-proofing, no fallback paths I did not ask for.
- Do not silently swallow errors to make output look clean.
```

```
VERIFY BEFORE YOU CLAIM DONE
- Run the project's own checks. In this repo: npm run lint and npm run typecheck.
  Do not invent test commands; use what package.json and the README actually define.
- Show me the real command output, not a summary of what you expect it to say.
- Then re-read your own diff line by line and confirm every line is required by the
  task. Delete anything that is not.
- If a check fails, fix the cause. Do not comment it out, do not add a try/catch
  around it, do not loosen a type to make it pass.

WHEN YOU GET STUCK
- If the same approach fails twice, stop tweaking it. Say what you actually observed,
  state your best guess at the root cause, and either try a genuinely different
  approach or ask me. Two failed attempts on one idea means the idea is wrong.
- If you broke something that was working, say so immediately and revert that part
  before continuing.
- Never guess at behavior you can check. Read the file, run the code, print the value.

WHEN YOU REPORT BACK
- List exactly which files you changed and why each one had to change.
- List anything you were unsure about or could not verify. Do not paper over it.
- Do not tell me it works unless you ran something that shows it works.
```

---

## Task

```
TASK: <one or two sentences, concrete>

FILES I EXPECT THIS TOUCHES: <paths, or "not sure — find them and tell me first">

MUST NOT CHANGE: <the working features/files you are protecting>

DONE MEANS: <the observable result you will accept>
```

---

## How to drive it

Small scope beats long runtime. A 60-minute unsupervised run on a vague task is how
working code gets rewritten. Give it one task, let it state the plan, approve, let it
edit, make it show real check output. Then the next task.

Commit before you hand it anything. `git add -A && git commit` first — then a bad run
costs you `git checkout .` instead of an afternoon. In this repo, don't use
`git stash`.

Three lines worth pasting mid-run when it drifts:

- "Stop. Show me the diff before you continue." — catches scope creep early.
- "You changed <file> and I didn't ask for that. Revert it and only do <task>."
- "Don't summarize. Paste the actual output of the command you ran."

Ask for a plan before the edits on anything non-trivial. Most bad output comes from
letting it start typing before it has read the callers.

