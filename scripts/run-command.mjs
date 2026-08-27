import { spawnSync } from "node:child_process";

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
