import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { db } from "./db";
import { messages, sessions } from "./db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getContextWindow } from "./context";

const gatewayBaseURL = process.env.AI_GATEWAY_BASE_URL || 'https://ai-gateway.vercel.sh';
const anthropic = createAnthropic({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: gatewayBaseURL.endsWith('/v1') ? gatewayBaseURL : `${gatewayBaseURL}/v1`,
});

const TRIGGER_RATIO = 0.75;
const TARGET_RATIO = 0.20;
const MIN_MESSAGES_TO_COMPACT = 5;
const COMPACTION_COOLDOWN_MS = 60000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function shouldCompactContext(
  sessionId: string,
  modelName: string,
  currentContextTokens: number
): Promise<boolean> {
  const contextLimit = getContextWindow(modelName);
  const triggerLimit = contextLimit * TRIGGER_RATIO;
  
  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const lastCompactedAt = session[0]?.lastCompactedAt;
  const timeSinceLastCompaction = lastCompactedAt ? Date.now() - lastCompactedAt.getTime() : Infinity;
  const isInCooldown = timeSinceLastCompaction < COMPACTION_COOLDOWN_MS;
  
  const messageCount = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)));
  const hasEnoughMessages = messageCount.length >= MIN_MESSAGES_TO_COMPACT;
  
  const shouldCompact = currentContextTokens >= triggerLimit && !isInCooldown && hasEnoughMessages;

  console.log(`[Compaction Check]
    Current context: ~${currentContextTokens} tokens
    Trigger limit: ${triggerLimit} tokens (${TRIGGER_RATIO * 100}%)
    Context limit: ${contextLimit} tokens
    Messages: ${messageCount.length} (min: ${MIN_MESSAGES_TO_COMPACT})
    Cooldown: ${isInCooldown ? `YES (${Math.round((COMPACTION_COOLDOWN_MS - timeSinceLastCompaction) / 1000)}s left)` : 'NO'}
    Will compact: ${shouldCompact ? 'YES ⚠️' : 'NO ✅'}${
      currentContextTokens >= triggerLimit && !shouldCompact 
        ? ` (blocked: ${isInCooldown ? 'cooldown' : 'not enough messages'})` 
        : ''
    }`);
  
  return shouldCompact;
}

export async function compactContext(
  sessionId: string,
  modelName: string
): Promise<{ compacted: boolean; tokensFreed: number }> {
  
  const allMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)))
    .orderBy(messages.createdAt);

  if (allMessages.length === 0) {
    return { compacted: false, tokensFreed: 0 };
  }

  const contextLimit = getContextWindow(modelName);
  const targetAfterCompaction = contextLimit * TARGET_RATIO;

  let tokensUsed = 0;
  const messagesToKeep: typeof allMessages = [];

  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i];
    const messageTokens = estimateTokens(m.content);

    if (tokensUsed + messageTokens > targetAfterCompaction) {
      break;
    }

    tokensUsed += messageTokens;
    messagesToKeep.unshift(m); 
  }

  const messagesToCompact = allMessages.filter(
    m => !messagesToKeep.some(keep => keep.id === m.id)
  );

  if (messagesToCompact.length === 0) {
    return { compacted: false, tokensFreed: 0 };
  }

  if (messagesToCompact.length < MIN_MESSAGES_TO_COMPACT) {
    console.log(`[Compaction] Skipped: Only ${messagesToCompact.length} messages to compact (min: ${MIN_MESSAGES_TO_COMPACT})`);
    return { compacted: false, tokensFreed: 0 };
  }

  const tokensBeforeCompaction = allMessages.reduce(
    (sum, m) => sum + estimateTokens(m.content), 
    0
  );

  const tokensToCompact = messagesToCompact
    .reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const tokensToKeep = messagesToKeep
    .reduce((sum, m) => sum + estimateTokens(m.content), 0);

  console.log(`[Compaction] Starting...
    Total messages: ${allMessages.length}
    Messages to compact: ${messagesToCompact.length} (~${tokensToCompact} tokens)
    Messages to keep: ${messagesToKeep.length} (~${tokensToKeep} tokens)
    Tokens before: ~${tokensBeforeCompaction}
    Target after: ~${Math.floor(targetAfterCompaction)}
    
    What's being summarized:
    - ${messagesToCompact.filter(m => m.role === 'user').length} user messages
    - ${messagesToCompact.filter(m => m.role === 'assistant').length} assistant messages
    - ${messagesToCompact.filter(m => m.role === 'system').length} system messages`);

  const conversationHistory = messagesToCompact
    .map((m) => {
      if (m.role === "user") return `<user_message>\n${m.content}\n</user_message>`;
      if (m.role === "assistant") return `<assistant_message>\n${m.content}\n</assistant_message>`;
      if (m.role === "system") return `<system_message>\n${m.content}\n</system_message>`;
      return m.content;
    })
    .join("\n\n");

  const summaryPrompt = `You have been working on the task described in the conversation below but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary.

<conversation_history>
${conversationHistory}
</conversation_history>

Your summary should be structured, concise, and actionable. Include:

1. Task Overview
   - The user's core request and success criteria
   - Any clarifications or constraints they specified

2. Current State
   - What has been completed so far
   - Files created, modified, or analyzed (with paths if relevant)
   - Key outputs or artifacts produced

3. Important Discoveries
   - Technical constraints or requirements uncovered
   - Decisions made and their rationale
   - Errors encountered and how they were resolved
   - What approaches were tried that didn't work (and why)

4. Next Steps
   - Specific actions needed to complete the task
   - Any blockers or open questions to resolve
   - Priority order if multiple steps remain

5. Context to Preserve
   - User preferences or style requirements
   - Domain-specific details that aren't obvious
   - Any promises made to the user

Be concise but complete—err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.

Wrap your summary in <summary></summary> tags.`;

  try {
    const { text: rawSummary, usage } = await generateText({
      model: anthropic("anthropic/claude-haiku-4-5-20251001"), 
      prompt: summaryPrompt,
    });

    const summaryMatch = rawSummary.match(/<summary>([\s\S]*?)<\/summary>/);
    const summary = summaryMatch ? summaryMatch[1].trim() : rawSummary.trim();

    const messageIds = messagesToCompact.map((m) => m.id);
    if (messageIds.length > 0) {
      await db
        .update(messages)
        .set({ compacted: true })
        .where(inArray(messages.id, messageIds));

      await db.insert(messages).values({
        sessionId,
        role: "system",
        content: `[Continuation Summary - Previous Context]\n\n${summary}`,
        createdAt: new Date(),
        compacted: false,
      });

      const summaryPromptTokens = usage?.inputTokens || 0;
      const summaryCompletionTokens = usage?.outputTokens || 0;
      const summaryTotalTokens = usage?.totalTokens || (summaryPromptTokens + summaryCompletionTokens);
      
      const summaryTokens = estimateTokens(summary);
      const tokensAfterCompaction = tokensUsed + summaryTokens;
      const tokensFreed = tokensBeforeCompaction - tokensAfterCompaction;

      console.log(`[Compaction] Complete ✅
    Compacted ${messagesToCompact.length} messages
    Summary length: ~${summaryTokens} tokens
    Tokens after: ~${tokensAfterCompaction}
    Net freed: ~${tokensFreed} tokens
    
    Summarization API usage:
      Input: ${summaryPromptTokens} tokens
      Output: ${summaryCompletionTokens} tokens
      Total: ${summaryTotalTokens} tokens

--- GENERATED SUMMARY ---
${summary}
--- END SUMMARY ---
`);

      await db
        .update(sessions)
        .set({ 
          cumulativePromptTokens: tokensAfterCompaction,
          updatedAt: new Date(),
          lastCompactedAt: new Date()
        })
        .where(eq(sessions.id, sessionId));

      return { compacted: true, tokensFreed };
    }
  } catch (error) {
    console.error("[Compaction] Error during compaction:", error);
  }

  return { compacted: false, tokensFreed: 0 };
}

export async function getMessagesForContext(sessionId: string): Promise<Array<{ role: "user" | "assistant" | "system"; content: string }>> {
  const allMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)))
    .orderBy(messages.createdAt);

  const convertedMessages = allMessages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));
  
  const systemMessages = convertedMessages.filter(m => m.role === "system");
  const otherMessages = convertedMessages.filter(m => m.role !== "system");
  
  if (systemMessages.length > 1) {
    const mergedSystemContent = systemMessages.map(m => m.content).join("\n\n---\n\n");
    return [
      { role: "system" as const, content: mergedSystemContent },
      ...otherMessages
    ];
  }
  
  return [...systemMessages, ...otherMessages];
}
