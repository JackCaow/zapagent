// Serve the just-built native candidate before its GitHub release exists.
const { createServer } = require("node:http");
const { createReadStream, readFileSync } = require("node:fs");
const { target, digest } = require("../npm/install.cjs");
const binary = process.argv[2], version = require("../package.json").version;
const asset = target(), prefix = `/v${version}/${asset}`;
const checksum = `${digest(readFileSync(binary))}  ${asset}\n`;
const server = createServer(async (request, response) => {
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    let text = "";
    for await (const bytes of request) text += bytes;
    const body = JSON.parse(text);
    const tool = body.messages.findLast(message => message.role === "tool");
    const delta = tool ? { content: String(tool.content).includes("NATIVE_FILE_CONTENT_OK") ? "NATIVE_TOOL_OK" : "READ_FAILED" }
      : { role: "assistant", tool_calls: [{ index: 0, id: "native-read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "native-proof.txt" }) } }] };
    const finish = tool ? "stop" : "tool_calls";
    const chunk = (data, reason) => ({ id: "native-fixture", object: "chat.completion.chunk", created: 1, model: "native-fixture", choices: [{ index: 0, delta: data, finish_reason: reason }] });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, finish))}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (request.url === `${prefix}.sha256`) return response.end(checksum);
  if (request.url !== prefix) { response.writeHead(404); return response.end(); }
  createReadStream(binary).on("error", () => response.destroy()).pipe(response);
});
server.listen(0, "127.0.0.1", () => process.send?.(`http://127.0.0.1:${server.address().port}`));
process.on("disconnect", () => server.close());
