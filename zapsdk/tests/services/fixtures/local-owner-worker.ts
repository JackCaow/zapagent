import { readFileSync } from "node:fs";
import { startLocalServiceOwner } from "../../../services/local-owner.js";
const options = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
try {
  const owner = await startLocalServiceOwner(options);
  process.stdout.write(JSON.stringify({ descriptorPath: owner.descriptorPath }) + "\n");
  let closing = false;
  const close = () => { if (closing) return; closing = true; void owner.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.on("SIGTERM", close); process.on("SIGINT", close);
} catch { process.stderr.write("Owner fixture startup failed\n"); process.exitCode = 1; }
