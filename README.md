# Context-Compacting Coding Agent

A coding agent that automatically compacts conversation history when approaching context limits.

## Setup

```bash
bun install
bun run index.ts
```

Requires Docker to be running.

## Environment Variables

- `ANTHROPIC_API_KEY` - Required for the LLM

## Notes

- Sessions persist to SQLite, so you can resume after restart
- If Docker container crashes, the agent will attempt to recreate it
- Long-running tasks may trigger multiple compaction cycles - this is expected
- First run creates the database automatically
