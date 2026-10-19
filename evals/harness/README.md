# Native service model fixture

`service-model-worker.ts` is a trusted SDK Host fixture for a preregistered
comparison. It is not a CLI/TUI service activation path. Copy the identical
worker into `evals/harness/` of each frozen SDK snapshot and retain its hash,
the SDK commit, Bun executable hash and the exact input/acceptance plan before
any model request. Never change an active comparison's worker or inputs.

The current worker uses `createServiceOperationId` from the selected SDK's
stable approval-key contract. Historical comparisons retain their original
worker and SDK hashes; use those frozen files to reproduce them. Do not copy
this revised worker into an older SDK that uses the authority-digest key.

The model receives only three semantic tools: request the `neutral-http`
preset, query an operation, and stop an owned service. No model-provided
command, source or program is executed. The Host constructs the fixed command
for a trusted preinstalled HTTP fixture and grants that operation explicitly.
The fixture's automatic approval is not a production permission policy.

Run with an isolated `ZAPCODE_DATA_DIR`:

```sh
bun evals/harness/service-model-worker.ts /absolute/private/config.json
```

The private configuration has `mode` (`owner`, `client`, or `stop`), canonical
`workspace` and `control` directories, `cancel`, `prompt`, `model`, `relayURL`,
`relayToken`, and optional `extraRequestParams`. The control directory must be
private and disjoint from the workspace. The Host starts an `owner` process,
waits for `owner-ready.json`, runs a separate `client`, then independently
checks the endpoint and receipts. `stop` exercises the same owner's explicit
stop operation. Real provider credentials stay in the Host relay; the worker
uses only its disposable relay token. Remove private configs after each run.

Normal retention checks the endpoint after the model client exits and again
after the Host's explicit stop. Cancellation pauses durable intent in the
trusted owner, cancels the client, observes a bounded wait and close behavior,
then releases the gate and checks the final record and absence of late launch.
The prototype override exists only in this deliberately selected fixture mode.

The owner requires the verified native macOS sandbox. Unsupported platforms
must be recorded as unavailable; do not disable the sandbox or silently fall
back to another backend. Independent cleanup must release any gate, request
owner close, stop the owned client/owner processes, and verify the endpoint is
closed. A trusted fixture-only `fixture-stop` file can request server cleanup;
using that fallback is not evidence that the service stop API succeeded.

The external verdict, model report correctness, provider-reported token usage,
cache reads, elapsed time and cleanup are separate observations. Record missing
usage as unknown. A small fault-injection experiment does not establish general
model reasoning improvement, Bench success or owner-crash containment.

Check the worker with the same strict project settings:

```sh
bun node_modules/typescript/bin/tsc --noEmit -p evals/harness/tsconfig.json
```
