import { runCommand } from "./run-command.mjs";
import { readdirSync } from "node:fs";

const tests = readdirSync("test")
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => `test/${name}`);
runCommand(process.execPath, ["--test", "--test-concurrency=1", ...tests]);
runCommand(process.execPath, ["scripts/test-payload.mjs"]);
