// Node's built-in fetch uses Undici's shared dispatcher. Older Node releases
// ignore NODE_USE_ENV_PROXY; this preload supplies the same proxy policy.
// Bun already implements environment proxies and must keep its own dispatcher.
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (!process.versions.bun && (major > 20 || (major === 20 && (minor > 18 || (minor === 18 && patch >= 1))))) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
