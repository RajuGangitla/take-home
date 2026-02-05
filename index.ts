import { generateText, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { initDb, db } from "./db";
import { sessions } from "./db/schema";
import { eq } from "drizzle-orm";
import { getMessagesForContext } from "./compaction";
import { ensureDockerContainer } from "./docker";
import { createInterface } from "readline";
import { tools } from "./tools";
import { saveMessage, ensureSession, ensureSystemPrompt, processUserMessage, handleAssistantResponse } from "./utils";
import 'dotenv/config';

const SESSION_ID = process.env.SESSION_ID || "default";
const MODEL_NAME = "anthropic/claude-opus-4-5-20251101";

const gatewayBaseURL = process.env.AI_GATEWAY_BASE_URL || 'https://ai-gateway.vercel.sh';
const anthropic = createAnthropic({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: gatewayBaseURL.endsWith('/v1') ? gatewayBaseURL : `${gatewayBaseURL}/v1`,
});

async function generateResponse(conversationHistory: Array<{ role: "user" | "assistant" | "system"; content: string }>) {
  const { API_TIMEOUT_MS } = await import("./utils");
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`API call timeout after ${API_TIMEOUT_MS / 1000} seconds`)), API_TIMEOUT_MS);
  });
  
  const generatePromise = generateText({
    model: anthropic(MODEL_NAME),
    messages: conversationHistory,
    tools,
    stopWhen: [
      ({ steps }) => {
        if (steps.length === 0) return false;
        const lastStep = steps[steps.length - 1];
        const hasText = Boolean(lastStep?.text && lastStep.text.trim().length > 0);
        const hasToolCalls = Boolean(lastStep?.toolCalls && lastStep.toolCalls.length > 0);
        return hasText && !hasToolCalls;
      },
      stepCountIs(10)
    ],
  });
  
  return await Promise.race([generatePromise, timeoutPromise]);
}

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error("Error: AI_GATEWAY_API_KEY environment variable is required");
    console.error("Get your API key from: https://vercel.com/docs/ai-gateway");
    process.exit(1);
  }

  await initDb();
  await ensureSession(SESSION_ID);
  await ensureDockerContainer();

  let conversationHistory = await getMessagesForContext(SESSION_ID);
  conversationHistory = await ensureSystemPrompt(SESSION_ID, conversationHistory);
  
  const messageCount = conversationHistory.length;
  console.log(`Starting agent with session ID: ${SESSION_ID}`);
  console.log(messageCount > 0 
    ? `Resuming session with ${messageCount} previous messages\n`
    : "Starting new session\n");
  console.log("Type your message (or 'exit' to quit):\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  };

  while (true) {
    const userInput = await question("> ");
    if (userInput.toLowerCase() === "exit") {
      break;
    }

    if (!userInput.trim()) {
      continue;
    }

    try {
      const session = await db.select().from(sessions).where(eq(sessions.id, SESSION_ID)).limit(1);
      const previousTokens = session[0]?.cumulativePromptTokens || 0;
      
      const conversationHistory = await processUserMessage(SESSION_ID, userInput, MODEL_NAME);
      
      if (conversationHistory.length === 0) {
        console.error("❌ [Error] No messages in conversation history!");
        continue;
      }
      
      const result = await generateResponse(conversationHistory);
      await handleAssistantResponse(SESSION_ID, {
        text: result.text,
        usage: result.usage,
      }, previousTokens);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("\n❌ [Error] An error occurred during generation:");
      console.error("   Message:", err.message);
      console.error("   Stack:", err.stack?.split('\n').slice(0, 3).join('\n'));
      console.error("");
      await saveMessage(SESSION_ID, "assistant", `Error: ${err.message}`);
    }
  }

  rl.close();
  console.log("Agent stopped.");
}

main().catch(console.error);
