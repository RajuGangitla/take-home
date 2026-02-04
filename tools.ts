import { tool } from "ai";
import { z } from "zod";
import { ensureDockerContainer, executeInContainer } from "./docker";
import { dirname } from "path";
import { WORKSPACE_DIR, FORBIDDEN_PATHS, normalizeWorkspacePath, validateWorkspacePath, validateCommand, parseDirectoryListing } from "./utils";

export const tools = {
  readFile: tool({
    description: `Read the contents of a file from ${WORKSPACE_DIR} directory inside the Docker container. All paths must be relative to ${WORKSPACE_DIR} or absolute starting with ${WORKSPACE_DIR}.`,
    inputSchema: z.object({
      path: z.string().describe(`Path to the file to read (relative to ${WORKSPACE_DIR} or absolute starting with ${WORKSPACE_DIR})`),
    }),
    execute: async ({ path }: { path: string }) => {
      try {
        await ensureDockerContainer();
        const normalizedPath = normalizeWorkspacePath(path);
        
        if (!validateWorkspacePath(normalizedPath)) {
          return { success: false, error: `Access denied: Cannot read ${path}. All operations must be in ${WORKSPACE_DIR} only.` };
        }
        
        const result = await executeInContainer(`cat "${normalizedPath}"`);
        return result.exitCode === 0
          ? { success: true, content: result.stdout }
          : { success: false, error: result.stderr || "File not found or cannot be read" };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    },
  }),

  writeFile: tool({
    description: `Write content to a file in ${WORKSPACE_DIR} directory inside the Docker container. All paths must be relative to ${WORKSPACE_DIR} or absolute starting with ${WORKSPACE_DIR}.`,
    inputSchema: z.object({
      path: z.string().describe(`Path to the file to write (relative to ${WORKSPACE_DIR} or absolute starting with ${WORKSPACE_DIR})`),
      content: z.string().describe("Content to write to the file"),
    }),
    execute: async ({ path, content }: { path: string; content: string }) => {
      try {
        await ensureDockerContainer();
        const normalizedPath = normalizeWorkspacePath(path);
        
        const dir = dirname(normalizedPath);
        if (dir !== "." && dir !== "/" && dir !== WORKSPACE_DIR) {
          await executeInContainer(`mkdir -p "${dir}"`);
        }
        
        const base64Content = Buffer.from(content, 'utf-8').toString('base64');
        const result = await executeInContainer(`echo '${base64Content}' | base64 -d > "${normalizedPath}"`);
        
        return result.exitCode === 0
          ? { success: true, path: normalizedPath }
          : { success: false, error: result.stderr || "Failed to write file" };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    },
  }),

  listDirectory: tool({
    description: `List files and directories in ${WORKSPACE_DIR} directory inside the Docker container. All paths must be relative to ${WORKSPACE_DIR} or absolute starting with ${WORKSPACE_DIR}. Defaults to ${WORKSPACE_DIR} if no path provided.`,
    inputSchema: z.object({
      path: z.string().optional().describe(`Path to the directory to list (relative to ${WORKSPACE_DIR} or absolute starting with ${WORKSPACE_DIR}, defaults to ${WORKSPACE_DIR})`),
    }),
    execute: async ({ path }: { path?: string }) => {
      try {
        await ensureDockerContainer();
        const normalizedPath = normalizeWorkspacePath(path);
        
        if (!validateWorkspacePath(normalizedPath)) {
          return {
            success: false,
            error: `Access denied: Cannot list ${path}. All operations must be in ${WORKSPACE_DIR} only.`,
            items: [],
          };
        }
        
        const result = await executeInContainer(`ls -lah "${normalizedPath}" 2>&1`);
        if (result.exitCode === 0) {
          return { success: true, items: parseDirectoryListing(result.stdout) };
        }
        return { success: false, error: result.stderr || "Directory not found or cannot be accessed" };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    },
  }),

  executeCommand: tool({
    description: `Execute a shell command in ${WORKSPACE_DIR} directory inside the Docker container. All commands must run in ${WORKSPACE_DIR} only.`,
    inputSchema: z.object({
      command: z.string().describe(`Shell command to execute (will be automatically prefixed with 'cd ${WORKSPACE_DIR} &&' to ensure it runs in workspace)`),
    }),
    execute: async ({ command }: { command: string }) => {
      try {
        await ensureDockerContainer();
        
        const validation = validateCommand(command);
        if (!validation.valid) {
          return {
            success: false,
            error: validation.error,
            stdout: '',
            stderr: validation.error,
            exitCode: 1,
          };
        }
        
        const workspaceCommand = command.trim().startsWith(`cd ${WORKSPACE_DIR}`)
          ? command
          : `cd ${WORKSPACE_DIR} && ${command}`;
        
        const result = await executeInContainer(workspaceCommand);
        return {
          success: result.exitCode === 0,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    },
  }),
};
