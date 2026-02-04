# Context-Compacting Coding Agent

A coding agent that automatically compacts conversation history when approaching context limits.

## Run

```bash
bun install
bun run index.ts
```

Requires Docker running.

## Environment Variables

Create `.env` file:

```
AI_GATEWAY_API_KEY=your_api_key_here
```

Optional:
```
AI_GATEWAY_BASE_URL=https://ai-gateway.vercel.sh
SESSION_ID=default
```

## Compaction Logic

```
Trigger:  Context ≥ 75% of limit
          + At least 5 messages
          + 1 min cooldown passed

Action:   Keep recent 20% of messages
          Summarize rest with Claude Haiku
          Insert summary as system message

Result:   ~25% context used → 75% free space
```

**Note:** For testing, context limit is set to 2,500 tokens in `context.ts`. Change to 200,000 for production.

## File Structure

```
├── index.ts          # Entry point
├── compaction.ts     # Compaction logic
├── context.ts        # Context window config
├── utils.ts          # Helpers
├── constants.ts      # Constants
├── prompts.ts        # System prompt
├── tools.ts          # Agent tools (read/write/execute)
├── docker.ts         # Container management
├── db/
│   ├── index.ts      # DB init
│   └── schema.ts     # Schema
└── sessions.db       # SQLite (auto-created)
```
