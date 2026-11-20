# Additional search providers and acceptance scenarios

Issue #801, 2026-11-17. Extend the existing provider registry and the existing
`enabled/apiKey/endpoint` configuration; do not add a database migration or change
the credential shape. Credential-source selection remains a design prototype.

The implementation follows the extracted desktop architecture: the tools module
owns configuration, routing and provider factories; HTTP effects stay in the
`.io.ts` boundaries. Desktop composition injects settings reads and publishes
search activity, while settings views use the presentation APIs and the existing
cross-window draft synchronization. No package or native ownership changes are
introduced.

Acceptance scenarios, recorded before implementation:

- Given Yuanbao or SearXNG returns more than 50 results, when the result limit is
  unset or zero, all returned results remain available. A positive limit still
  caps the returned list. Yuanbao requests its largest supported batch when no
  limit is set; upstream page limits and explicit native options still apply.
- Given an existing search configuration, adding Doubao, Qianfan, TinyFish and
  Serper preserves all previous settings and leaves the new keyed engines off
  until configured. Every engine is selectable through the existing cards and
  routing controls, with Chinese and English descriptions.
- Given a configured new engine, a search uses that engine's documented endpoint,
  authentication and filters, returns attributable source URLs and preserves
  supported content and native metadata. Explicit provider selection stays single.
- Given Doubao Custom/Global or multimodal options, the corresponding response
  shape is parsed; native options stay confined to that engine. Unsupported
  combinations and upstream application errors are visible rather than empty success.
- Given TinyFish pagination or Serper news/image results, the result list is
  usable through the same search contract. Missing keys, empty results and HTTP
  authentication/rate-limit errors follow existing availability/error handling.

References and retrieval status:

- Doubao Custom: https://docs.volcengine.com/docs/zh/networked-search/networked-search.md
- Doubao Global: https://docs.volcengine.com/docs/zh/networked-search/doubao-search-global-edition.md
- Doubao billing: https://docs.volcengine.com/docs/zh/networked-search/online-search-product-billing.md
- Qianfan: https://cloud.baidu.com/doc/qianfan/s/2mh4su4uy
- TinyFish: published `@tiny-fish/sdk` 0.11.0, `dist/search/{index,types}.js`,
  `dist/_utils/client.js`; downloaded from the npm mirror and inspected, not
  installed as a dependency. Official docs: https://docs.tinyfish.ai/
- Serper: https://serper.dev/ . Current official page retrieval was unavailable
  in this environment; no current numeric free allowance is asserted.

This is adapter validation with network fixtures, not paid live-account testing.
