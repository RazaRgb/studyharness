# Study Harness

A personal learning harness for Obsidian. It probes what you already know, builds a small dependency plan, teaches one reasoning step at a time, records evidence in a knowledge bank, and can turn the result into flashcards.

This is the v1 implementation. It is intentionally small and API-first.

## Setup

1. Enable **Study Harness** in **Settings → Community plugins**. If it does not appear, reload Obsidian once.
2. Open **Settings → Study Harness**.
3. Add an API key and set a base URL and model.

Recommended starting point: OpenRouter.

- Base URL: `https://openrouter.ai/api/v1`
- Model: `openai/gpt-4o-mini` (or another model you have access to)
- API key: your OpenRouter key

The plugin calls an OpenAI-compatible `/chat/completions` endpoint with tool calling and streaming. All model calls go through the API; there is no local model in v1.

## Use

Open the workspace with the ribbon icon or the command **Study Harness: Open study workspace**.

Starting a session asks for:

- **Topic** — what you want to learn
- **Intent** — conceptual, exam, research, application, memorisation, maintenance
- **Mode** — study/teach or practice

The teacher is instructed to:

1. Probe with a few questions.
2. Build a plan with `plan_init`.
3. Teach one reasoning step at a time.
4. End each step with a short next-step cue and a prediction/check.
5. Record evidence and repair gaps before moving on.
6. Finish with optional flashcards; the knowledge graph is extracted in the background.

## Knowledge graph

Open the graph with the ribbon/command or from a session header.

- Each plan node becomes a knowledge node.
- Plan edges become prerequisite edges.
- MCQ answers automatically add evidence.
- Free-text answers add evidence when the model calls `record_evidence`.
- Node colour intensity is derived from evidence strength, not stored as a single "understanding" value.
- Click a node to see its statement, kind, strength breakdown, recent evidence, and source sessions.
- **Study this** starts a conceptual session focused on that node.
- **Practice this** starts a practice session focused on that node.

The graph is stored separately from Obsidian's note graph. It is not dependent on generated Markdown notes.

## Flashcards

Use the layers icon in the session header or the command **Study Harness: Generate flashcards for current session**.

The deck is written to:

```text
StudyHarness/Flashcards/
```

It uses the format your **Spaced Flashcards** plugin already understands:

```yaml
---
flashcard: true
---
## front

back
```

The model is asked to generate only high-value cards, not a card for every sentence.

## Session management

Open the session panel from the list ribbon icon, the native session-header history action, or the command **Study Harness: Open sessions panel**.

- Search and filter sessions (all, study, practice, waiting for answer, empty)
- Resume a session, including one waiting on a question
- Rename sessions
- Delete individual sessions
- Delete all empty sessions at once
- See phase, intent, message count, pending questions, and graph-extraction state

## Post-session graph extraction

When a session finishes, the harness extracts propositions and prerequisite links from the transcript into the knowledge graph in the background. This adds more than the plan nodes: it captures ideas and connections that emerged during teaching.

You can also run it manually from the finished-session card or with **Study Harness: Extract knowledge graph from current session**. Re-extraction is available; imported nodes are deduplicated by name/statement when possible.

## Notes import

Use the upload icon in the graph header, the session header, or **Study Harness: Import notes into knowledge graph**.

Choose Markdown notes from the vault, set a domain label, and the model extracts propositions and links into the knowledge graph. Notes are read-only: nothing is written back to them. Node detail cards show their source notes when available.

## Data

Plugin state lives in:

```text
.obsidian/plugins/study-harness/data.json
```

That includes settings, sessions, knowledge nodes, edges, evidence, and note-import records. Keep API keys out of synced notes. If you sync plugin data, treat it as sensitive.

## What is not in v1

- Local models or local judges
- Full LearnHarness-style extraction pipeline
- Research/PDF/demo subagents
- Application Gym / code runner
- Multi-provider subscription auth
- Mobile support (this plugin is desktop-only)

The graph in v1 is built from plan nodes, learning evidence, post-session extraction, and imported notes. It is deliberately simpler than a full LearnHarness-style extraction pipeline.

## Development

```bash
npm install --no-bin-links   # needed on this vault's mounted drive
npm run typecheck
npm run build
```

Then run **Study Harness: Reload Study Harness (dev)** from the command palette, or reload Obsidian.

## Known limitations

- The model may occasionally ignore the tool protocol or ask a question in prose. The system prompt asks for one `ask_learner` tool call per turn; v1 does not retry prose questions.
- The transcript is sent to the API as-is. There is no compaction or token budgeting yet.
- Free-text grading is done by the model in the next turn; it may be imperfect.
- The graph layout is deterministic but not manually editable.
- Flashcard generation is a separate API call from the session.
