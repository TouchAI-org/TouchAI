# External agent protocol boundary

The implemented transport is A2A v1.0 HTTP+JSON with REST task operations and
SSE streaming. It uses `@a2a-js/sdk` through a lazy dynamic import, and every
registered row currently has `protocol = 'a2a'`.

ACP is not a second runtime protocol in this release. The ACP project joined
A2A on 2025-08-29, so maintaining parallel discovery, task, and streaming
clients would duplicate state and error semantics. `protocolAdapter.ts` is the
normalization seam for a future adapter:

- Discovery must produce the same validated `ExternalAgentCard` shape.
- Invocation must preserve sync, async polling, SSE snapshot, cancellation,
  timeout, error-code, size-limit, and side-effect semantics.
- URL policy, per-call approval, and the no-credential rule stay outside the
  adapter and cannot be relaxed by protocol-specific code.
- Supporting a persisted non-A2A value requires a separate schema decision;
  the current database enum intentionally contains only `a2a`.

JSON-RPC, gRPC, push notifications, A2A v0.3, remote multi-turn `contextId`
continuation, and binary attachment download are also out of scope for v1.
