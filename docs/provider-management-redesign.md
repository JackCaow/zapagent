# Provider management redesign

## Boundaries

Connection settings identify endpoint, protocol and authentication. Model discovery
lists endpoint IDs; public catalog metadata describes specifications, not account
entitlement. Saved model preferences and the active session choice are user-owned.
Neither discovery nor catalog refresh may silently remove saved aliases or switch models.
VM policy and packaging are outside this module.

## Implemented foundation

- Provider selection is now sourced from models.dev, not `PROVIDER_PRESETS`.
  `/connect` loads the cached public directory and supports `/` search. Adapter
  declarations determine protocol compatibility, not provider names. Unsupported
  adapters are disabled; absent/invalid public API addresses require user input.
  Custom connections remain usable when the directory is offline. The saved
  `catalogProviderId` is the exact lookup key for subsequent discovery/hydration.
  This directory does not prove endpoint compatibility or account access.
- The old combined wizard is removed. `/connect` manages named connections,
  endpoint, explicit protocol and API-key/no-auth mode, followed by a save review.
  Saving a connection never invents a model or switches an existing active choice.
  `/model` independently discovers IDs, shows metadata/source/access-unknown status,
  filters the directory and accepts manual IDs. `p` changes the browsed connection,
  `r` repeats endpoint discovery, `/` filters and `t` enters a manual ID.
- `provider-catalog.ts` separates read-only discovery from explicit selection.
  Results do not persist until selection. Saved aliases survive failures and
  capability values remain tri-state (yes/no/unknown). `authMode: none` suppresses
  both authentication headers on discovery and inference requests.
- `ModelCatalogCache` owns a versioned public-only disk snapshot under
  `ZAPCODE_DATA_DIR/cache/models-dev-v1.json` (default `~/.zapcode/cache`).
  Fresh data has a 24-hour TTL; stale data is returned immediately while a single
  refresh runs. Failed stale refreshes back off for a minute. Cold discovery has
  a bounded fetch; failure keeps saved models and manual configuration available.
  Writes are atomic and best-effort; malformed responses do not replace valid data.
- Metadata hydration commits only metadata for unchanged provider objects against
  the latest configuration. Changes to credentials, model lists or removal win.
- Metadata priority: explicit/manual or endpoint facts precede models.dev. Unknown
  fields never erase known facts; model and provider IDs must match exactly.
- Discovery shares one deadline across path probes, supports caller cancellation,
  and sends no authentication headers for an empty key. The wizard ignores late
  results after its timeout or a switch to manual input.
- Environment bootstrap inherits the same protocol/request opt-ins as presets.

## Remaining architecture work (not implemented yet)

1. CredentialStore with references, environment lookup and explicit storage policy;
   migrate old inline keys only after successful read/write verification. No silent
   keychain-to-plaintext downgrade. Never persist secret values into catalog cache.
2. ProviderService owns revisioned mutations, separates persisted connections,
   defaults/favorites and session bindings; add cross-process conflict handling.
3. RuntimeResolver creates an immutable run snapshot shared by CLI/headless/host;
   adapter owns authentication headers, discovery paths and capability constraints.
4. Move model metadata out of config into the catalog layer, retaining explicit
   per-deployment overrides; add bundled catalog snapshot generation/provenance.
5. Add pricing with currency/unit/provider provenance, without treating catalogue
   pricing as gateway-specific billing. Add Responses/OAuth through adapter contracts.

## Acceptance

Run isolated provider/cache/config tests, TypeScript checking and the root Bun suite.
Verify editing keyless and inactive providers in the actual TUI; tests must use a
disposable data directory and mock endpoints, never real account credentials.
Offline startup must retain configured selections; no automatic fallback providers.
