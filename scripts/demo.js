import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemo } from "../lib/demo-data.js";
import { start } from "../server.js";

const directory = mkdtempSync(join(tmpdir(), "copilot-memory-demo-"));
const path = join(directory, "session-store.db");
createDemo(path);
console.log("DEMO MODE: synthetic example history only.");
const server = start({ path, dataPath: join(directory, "state") });
function stop() {
  server.close(() => process.exit(0));
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
