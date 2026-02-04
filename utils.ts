import { db } from "./db";
import { sessions, messages } from "./db/schema";
import { eq } from "drizzle-orm";
import { getMessagesForContext } from "./compaction";
import { SYSTEM_PROMPT } from "./prompts";
import { WORKSPACE_DIR, FORBIDDEN_PATHS, API_TIMEOUT_MS } from "./constants";

export { WORKSPACE_DIR, FORBIDDEN_PATHS, API_TIMEOUT_MS };

export function normalizeWorkspacePath(path: string | undefined): string {
  if (!path) return WORKSPACE_DIR;
  return path.startsWith(WORKSPACE_DIR) ? path : `${WORKSPACE_DIR}/${path}`;
}

export function validateWorkspacePath(path: string): boolean {
  return path.startsWith(WORKSPACE_DIR);
}

export function validateCommand(command: string): { valid: boolean; error?: string } {
  const lowerCommand = command.toLowerCase();
  for (const forbiddenPath of FORBIDDEN_PATHS) {
    if (lowerCommand.includes(forbiddenPath) && !lowerCommand.includes(WORKSPACE_DIR)) {
      return {
        valid: false,
        error: `Access denied: Cannot access ${forbiddenPath}. All operations must be in ${WORKSPACE_DIR} only.`
      };
    }
  }
  return { valid: true };
}

export function parseDirectoryListing(output: string) {
  const lines = output.trim().split('\n').slice(1);
  return lines
    .filter(line => line.trim())
    .map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) return null;
      
      const name = parts.slice(8).join(' ');
      const isDir = line.startsWith('d');
      const sizeStr = parts[4] || '0';
      const size = sizeStr.match(/^\d+$/) ? parseInt(sizeStr) : 0;
      
      return {
        name,
        type: isDir ? "directory" as const : "file" as const,
        size,
      };
    })
    .filter(item => item !== null);
}

export function estimatePromptTokens(messages: Array<{ role: string; content: string }>): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.floor(totalChars / 4);
}

export interface TokenUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

export function getContextTokensFromUsage(usage: TokenUsage): number {
  return usage.inputTokens ?? 0;
}

export async function saveMessage(sessionId: string, role: "user" | "assistant" | "system", content: string) {
  await db.insert(messages).values({
    sessionId,
    role,
    content,
    createdAt: new Date(),
    compacted: false,
  });
}

export async function ensureSession(sessionId: string) {
  const existing = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (existing.length === 0) {
    await db.insert(sessions).values({
      id: sessionId,
      createdAt: new Date(),
      updatedAt: new Date(),
      cumulativePromptTokens: 0,
    });
  } else {
    await db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, sessionId));
  }
}

export async function calculateContextTokens(sessionId: string): Promise<number> {
  const conversationHistory = await getMessagesForContext(sessionId);
  return conversationHistory.reduce((sum, m) => sum + estimatePromptTokens([m]), 0);
}

export async function updateTokenCount(sessionId: string) {
  const newContextTokens = await calculateContextTokens(sessionId);
  await db
    .update(sessions)
    .set({ 
      cumulativePromptTokens: newContextTokens,
      updatedAt: new Date()
    })
    .where(eq(sessions.id, sessionId));
}

export async function ensureSystemPrompt(sessionId: string, conversationHistory: Array<{ role: "user" | "assistant" | "system"; content: string }>) {
  const hasSystemMessage = conversationHistory.some(msg => msg.role === "system");
  if (!hasSystemMessage) {
    await saveMessage(sessionId, "system", SYSTEM_PROMPT);
    return await getMessagesForContext(sessionId);
  }
  return conversationHistory;
}

export async function processUserMessage(sessionId: string, userInput: string, modelName: string) {
  await saveMessage(sessionId, "user", userInput);
  
  let conversationHistory = await getMessagesForContext(sessionId);
  
  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const storedTokens = session[0]?.cumulativePromptTokens || 0;
  const estimatedTokens = await calculateContextTokens(sessionId);
  
  const currentContextTokens = storedTokens > 0 ? storedTokens : estimatedTokens;
  
  const { shouldCompactContext, compactContext } = await import("./compaction");
  const needsCompaction = await shouldCompactContext(sessionId, modelName, currentContextTokens);
  if (needsCompaction) {
    console.log("\n⚠️  Context limit approaching - compacting...\n");
    await compactContext(sessionId, modelName);
    conversationHistory = await getMessagesForContext(sessionId);
  }
  
  return conversationHistory;
}

export async function handleAssistantResponse(
  sessionId: string, 
  result: { text?: string; usage?: { inputTokens?: number; outputTokens?: number } }
) {
  const assistantMessageContent = result.text?.trim() || "";
  
  if (assistantMessageContent) {
    await saveMessage(sessionId, "assistant", assistantMessageContent);
    console.log(`\nAssistant: ${assistantMessageContent}\n`);
    
    if (result.usage && result.usage.inputTokens !== undefined) {
      const inputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;
      const totalTokens = inputTokens + outputTokens;
      
      console.log(`[Token Usage]
    Input (context): ${inputTokens} tokens
    Output: ${outputTokens} tokens
    Total: ${totalTokens} tokens`);
      
      await db
        .update(sessions)
        .set({ 
          cumulativePromptTokens: inputTokens,
          updatedAt: new Date()
        })
        .where(eq(sessions.id, sessionId));
    } else {
      await updateTokenCount(sessionId);
    }
  }
}
