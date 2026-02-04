import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";

const sqlite = new Database("sessions.db");
export const db = drizzle(sqlite, { schema });

export async function initDb() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cumulative_prompt_tokens INTEGER DEFAULT 0,
      last_compacted_at INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      compacted INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `);

  try {
    sqlite.exec(`SELECT cumulative_prompt_tokens FROM sessions LIMIT 1`);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.message?.includes('no such column')) {
      try {
        sqlite.exec(`ALTER TABLE sessions ADD COLUMN cumulative_prompt_tokens INTEGER DEFAULT 0;`);
        console.log('Added cumulative_prompt_tokens column to existing database');
      } catch (alterError: unknown) {
        const alterErr = alterError instanceof Error ? alterError : new Error(String(alterError));
        console.error('Failed to add column:', alterErr.message);
      }
    }
  }

  try {
    sqlite.exec(`SELECT last_compacted_at FROM sessions LIMIT 1`);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.message?.includes('no such column')) {
      try {
        sqlite.exec(`ALTER TABLE sessions ADD COLUMN last_compacted_at INTEGER;`);
        console.log('Added last_compacted_at column to existing database');
      } catch (alterError: unknown) {
        const alterErr = alterError instanceof Error ? alterError : new Error(String(alterError));
        console.error('Failed to add column:', alterErr.message);
      }
    }
  }
}
