import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const command = process.argv[2];
if (!command || !["dev", "build", "start"].includes(command)) {
  console.error("Usage: node scripts/vinext.mjs <dev|build|start>");
  process.exit(1);
}

const cli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));
const child = spawn(process.execPath, [cli, command], {
  stdio: "inherit",
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
