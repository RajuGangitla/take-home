import { $ } from "bun";

const CONTAINER_NAME = "context-compacting-agent-exec";
const COMMAND_TIMEOUT_SECONDS = 30;

const DOCKER_RUN_ARGS = [
  "-d",
  `--name ${CONTAINER_NAME}`,
  "--workdir /workspace",
  "--memory 512m",
  "--cpus 1",
  "--pids-limit 64",
  "--security-opt no-new-privileges",
].join(" ");

export async function ensureDockerContainer(): Promise<void> {
  try {
    const { stdout } = await $`docker ps -a --filter name=${CONTAINER_NAME} --format {{.Names}}`.quiet();
    const containerExists = stdout.toString().trim() === CONTAINER_NAME;

    if (containerExists) {
      const { stdout: running } = await $`docker ps --filter name=${CONTAINER_NAME} --format {{.Names}}`.quiet();
      if (running.toString().trim() === CONTAINER_NAME) {
        return;
      }
      await $`docker start ${CONTAINER_NAME}`;
      return;
    }

    await $`docker run ${DOCKER_RUN_ARGS} node:20-alpine sh -c "tail -f /dev/null"`.quiet();
  } catch (error) {
    try {
      await $`docker rm -f ${CONTAINER_NAME}`.quiet();
      await $`docker run ${DOCKER_RUN_ARGS} node:20-alpine sh -c "tail -f /dev/null"`.quiet();
    } catch (recreateError) {
      throw new Error(`Failed to create Docker container: ${recreateError}`);
    }
  }
}

export async function executeInContainer(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await ensureDockerContainer();
  
  const timeoutCommand = `timeout ${COMMAND_TIMEOUT_SECONDS} sh -c ${JSON.stringify(command)}`;
  
  try {
    const result = await $`docker exec ${CONTAINER_NAME} sh -c ${timeoutCommand}`.quiet();
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode || 0,
    };
  } catch (error: unknown) {
    const shellError = error as { stdout?: Buffer; stderr?: Buffer; message?: string; exitCode?: number };
    const exitCode = shellError.exitCode || 1;
    
    if (exitCode === 124) {
      return {
        stdout: shellError.stdout?.toString() || "",
        stderr: `Command timed out after ${COMMAND_TIMEOUT_SECONDS} seconds`,
        exitCode: 124,
      };
    }
    
    return {
      stdout: shellError.stdout?.toString() || "",
      stderr: shellError.stderr?.toString() || shellError.message || "",
      exitCode,
    };
  }
}
