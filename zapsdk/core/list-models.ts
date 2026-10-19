/**
 * Fetch the available model list from an OpenAI/Anthropic-compatible
 * `/models` endpoint.
 *
 * Auth follows the protocol: OpenAI sends `Authorization: Bearer`, Anthropic
 * sends `x-api-key` + `anthropic-version`. An Anthropic-protocol request that
 * gets a 401 is retried once on the same URL with Bearer added, because
 * compatible gateways often expose an OpenAI-style `/models` above the
 * Anthropic path.
 *
 * Path probing: walks the baseURL's path from most-specific to host
 * root, retrying `/models` at each level when the previous one returns
 * 404/405. Required because providers split where they expose models
 * vs the chat/messages endpoint:
 *   DeepSeek                — chat at `/v1/chat/completions`,
 *                             models at root `/models`
 *   DeepSeek Anthropic mode — messages at `/anthropic/v1/messages`,
 *                             models still at root `/models`
 *   GLM (Zhipu) Anthropic   — varies by deployment
 *   Anthropic official      — models at `/v1/models`
 * Auth/server errors (401/403/5xx) do NOT trigger the walk — those
 * mean the path is fine and the failure is real. Capped at 4 levels
 * to bound network retries on deeply-nested URLs.
 *
 * Response is the standard `{data: [{id}]}` shape. Returns sorted
 * unique ids. Throws on network error, non-2xx (after the path probe),
 * or empty list.
 */
export async function listModels(
  baseURL: string,
  apiKey: string,
  timeoutMs = 8000,
  signal?: AbortSignal,
  protocol?: "openai" | "openai-responses" | "anthropic",
): Promise<string[]> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  // Walk from the most-specific path UP to the host root, attempting both
  // `${prefix}/models` AND `${prefix}/v1/models` at each level. Real cases:
  //   `https://api.anthropic.com/v1`        →  /v1/models           ✓ first try
  //   `https://api.anthropic.com`           →  /models 404 → /v1/models ✓
  //   `https://api.deepseek.com/v1`         →  /v1/models 404 → /models ✓
  //   `https://api.deepseek.com/anthropic`  →  /anthropic/models 404 → walk up
  //   `https://open.bigmodel.cn/api/anthropic` → walks up similarly
  // Cap at 6 URLs total (≈3 prefix levels × 2 path variants) so a deeply
  // nested URL doesn't fan out unbounded — each retry is a real network req.
  const trimmed = baseURL.replace(/\/+$/, "")
  const prefixes: string[] = [trimmed]
  try {
    const u = new URL(trimmed)
    let path = u.pathname.replace(/\/+$/, "")
    while (path && prefixes.length < 3) {
      const next = path.slice(0, path.lastIndexOf("/"))
      const candidate = `${u.origin}${next}`
      if (!prefixes.includes(candidate)) prefixes.push(candidate)
      if (next === "") break
      path = next
    }
  } catch { /* malformed URL — caller will see the original failure */ }

  // For each prefix try `/models` then `/v1/models`. Skip the `/v1/models`
  // variant when the prefix already ends in `/v1` (would yield `/v1/v1/models`
  // — pure waste). Dedupe via Set so overlapping prefixes don't double-probe.
  const urls: string[] = []
  const seen = new Set<string>()
  for (const prefix of prefixes) {
    for (const suffix of ["/models", "/v1/models"]) {
      if (suffix === "/v1/models" && /\/v1$/.test(prefix)) continue
      const url = prefix + suffix
      if (!seen.has(url)) { seen.add(url); urls.push(url) }
    }
  }

  const request = (url: string, withBearer: boolean) => fetch(url, {
    headers: {
      ...(apiKey ? {
        ...(withBearer ? { "Authorization": `Bearer ${apiKey}` } : {}),
        ...((protocol === undefined || protocol === "anthropic") ? { "x-api-key": apiKey } : {}),
      } : {}),
      ...((protocol === undefined || protocol === "anthropic") ? { "anthropic-version": "2023-06-01" } : {}),
      "Accept": "application/json",
    },
    signal: requestSignal,
  })

  let lastErr: Error | null = null
  for (const url of urls) {
    requestSignal.throwIfAborted()
    let resp = await request(url, protocol !== "anthropic")
    // Anthropic-compatible gateways serve `/messages` under one path but expose
    // an OpenAI-style `/models` a level up, which wants Bearer. Send the
    // Anthropic-native header first and add Bearer only after a 401.
    if (resp.status === 401 && protocol === "anthropic" && apiKey) {
      await resp.body?.cancel().catch(() => {})
      requestSignal.throwIfAborted()
      resp = await request(url, true)
    }
    if (resp.ok) {
      // 200 OK is necessary but not sufficient — gateways often return their
      // SPA index (text/html) at unknown paths instead of 404, so we have to
      // sniff the body shape too. Treat "200 but not a models list" as a
      // wrong-path signal and walk on, same as 404/405.
      let json: { data?: Array<{ id?: unknown }> } | null = null
      try { json = await resp.json() as { data?: Array<{ id?: unknown }> } } catch { /* non-JSON body */ }
      if (json && Array.isArray(json.data)) {
        const ids = Array.from(new Set(
          json.data
            .map(m => typeof m.id === "string" ? m.id : null)
            .filter((x): x is string => !!x),
        ))
        if (ids.length > 0) return ids.sort()
      }
      lastErr = new Error(`200 OK but no models list at ${url}`)
      continue
    }
    const body = await resp.text().catch(() => "")
    lastErr = new Error(`HTTP ${resp.status}${body ? `: ${body.slice(0, 120)}` : ""}`)
    // Only the "path is wrong" status codes warrant trying the alt URL.
    // 401/403/5xx etc. mean the request reached a real handler — don't
    // mask those by switching paths.
    if (resp.status !== 404 && resp.status !== 405) break
  }
  throw lastErr ?? new Error("listModels: no candidate URLs")
}
