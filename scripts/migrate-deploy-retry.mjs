import { spawn } from "node:child_process";

const maxAttempts = Math.min(
  8,
  Math.max(1, Number.parseInt(process.env.MIGRATION_MAX_ATTEMPTS || "5", 10) || 5),
);
const retryDelaysMs = [0, 5_000, 15_000, 30_000, 60_000];

const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function runMigration() {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(command, ["--no-install", "prisma", "migrate", "deploy"], {
      env: {
        ...process.env,
        ...(process.env.DIRECT_DATABASE_URL
          ? { PRISMA_MIGRATE_DATABASE_URL: process.env.DIRECT_DATABASE_URL }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      output += chunk.toString();
    });
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

const isAdvisoryLockTimeout = (output) =>
  /P1002|advisory lock|timed out trying to acquire/i.test(output);

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const delay = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)];
  if (delay > 0) {
    console.warn(`Migration lock busy; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${maxAttempts}).`);
    await sleep(delay);
  }

  const result = await runMigration();
  if (result.code === 0) {
    process.exitCode = 0;
    break;
  }

  if (!isAdvisoryLockTimeout(result.output) || attempt === maxAttempts) {
    process.exitCode = result.code;
    break;
  }
}
