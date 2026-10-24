// The CLI is a compiled executable; only SDK/source development needs Bun.
const { createHash, randomUUID } = require("node:crypto");
const { chmodSync, createReadStream, createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");

const assets = Object.freeze({
  "darwin-arm64": "zap-macos-arm64", "darwin-x64": "zap-macos-x64",
  "linux-arm64": "zap-linux-arm64", "linux-x64": "zap-linux-x64",
  "win32-x64": "zap-windows-x64.exe",
});
function target(platform = process.platform, arch = process.arch) {
  const asset = assets[`${platform}-${arch}`];
  if (!asset) throw new Error(`zapAgent does not provide a binary for ${platform}/${arch}. Supported: ${Object.keys(assets).join(", ")}`);
  return asset;
}
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function validBinary(file, checksum) {
  if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) return false;
  try {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest("hex") === checksum;
  } catch { return false; }
}
async function ensureBinary(options = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const asset = target(platform, arch);
  const version = options.version ?? require("../package.json").version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid zapAgent package version");
  const env = options.env ?? process.env;
  const cache = env.ZAPAGENT_CACHE_DIR || (platform === "win32" ? env.LOCALAPPDATA : env.XDG_CACHE_HOME) || join(homedir(), ".cache");
  const file = join(cache, "zapagent", version, `${platform}-${arch}`, platform === "win32" ? "zap.exe" : "zap");
  const checksumFile = `${file}.sha256`;
  let checksum;
  try { checksum = readFileSync(checksumFile, "utf8").trim(); } catch {}
  if (await validBinary(file, checksum)) return file;
  const base = new URL(env.ZAPAGENT_DOWNLOAD_BASE_URL || "https://github.com/JackCaow/zapagent/releases/download/");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) {
    throw new Error("Binary downloads require HTTPS (HTTP is allowed only for loopback tests)");
  }
  const url = `${base.href.replace(/\/$/, "")}/v${version}/${asset}`;
  const fetcher = options.fetch ?? fetch;
  async function download(address) {
    const response = await fetcher(address, { signal: AbortSignal.timeout(180_000), redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${address}`);
    return response;
  }
  // Validate metadata before fetching executable bytes. Never run a partial download.
  const metadata = await (await download(`${url}.sha256`)).text();
  const match = metadata.trim().match(/^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)$/);
  if (!match || match[2] !== asset) throw new Error(`Invalid checksum metadata for ${asset}`);
  checksum = match[1].toLowerCase();
  const response = await download(url);
  if (!response.body) throw new Error(`Empty binary response for ${asset}`);
  mkdirSync(dirname(file), { recursive: true });
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    const hash = createHash("sha256");
    const meter = new Transform({ transform(bytes, _encoding, done) { hash.update(bytes); done(null, bytes); } });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(pending, { flags: "wx", mode: 0o600 }));
    if (hash.digest("hex") !== checksum) throw new Error(`Checksum verification failed for ${asset}`);
    chmodSync(pending, 0o755);
    try { renameSync(pending, file); } catch (error) {
      // Concurrent installers may finish the same verified download on Windows.
      if (!await validBinary(file, checksum)) throw error;
    }
    writeFileSync(checksumFile, `${checksum}\n`);
  } finally { rmSync(pending, { force: true }); }
  return file;
}
module.exports = { assets, target, digest, ensureBinary };
if (require.main === module) {
  ensureBinary().catch(error => {
    // npm/Bun --ignore-scripts and temporary network failures are recoverable at launch.
    console.warn(`zapAgent binary setup deferred: ${error.message}\nRun zap to retry. No separate Bun installation is needed.`);
  });
}
