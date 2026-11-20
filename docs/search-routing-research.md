# Search selection and provider capability review

Issue: #801. Checked on 2026-11-17. Scope: TouchAI's `web_search` tool and Search
settings. This review describes public documentation and source code; it is not a
benchmark or a claim that paid APIs were exercised with live credentials.

## Third-party agent products

| Product       | Verified behavior                                                                                                                                                                                                                                                                        | Useful lesson for TouchAI                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LobeHub       | `SEARCH_PROVIDERS` accepts multiple backends. User channel preferences order the enabled providers. `webSearch()` tries them sequentially; on empty results it first removes engine selection, then other search parameters, before moving on. Direct `query()` uses the first provider. | Make provider priority visible and configurable. Treat retry and parameter relaxation as distinct decisions; TouchAI retains requested filters rather than silently relaxing them. |
| Cherry Studio | The current main-process service selects providers by capability, supports per-input failure recovery through a fallback chain, and preserves provider attribution. The agent's built-in search wrapper primarily supplies the query; the service resolves providers.                    | Separate provider configuration, capability support, and execution. Keep source attribution after fallback.                                                                        |
| SearXNG       | Its search API exposes engines, categories, language, time range, and page number. The deployment decides which upstream engines are available.                                                                                                                                          | A metasearch backend offers breadth, but specialist APIs still provide distinct evidence and parameters.                                                                           |

These products support configurable backends. Their source does not establish that
one search engine is universally best, nor that either product always fuses every
configured provider. Multiple queries to one provider are also different from
querying multiple providers.

Sources:

- [LobeHub SearchService, revision 69f8dcdf](https://github.com/lobehub/lobehub/blob/69f8dcdfae1c59a5ffb703b3a0187223987bcd56/apps/server/src/services/search/index.ts)
- [Cherry Studio WebSearchService, revision 6b713478](https://github.com/CherryHQ/cherry-studio/blob/6b713478db0f938c346d84263e42b8d311081800/src/main/services/webSearch/WebSearchService.ts)
- [Cherry Studio built-in search tool](https://github.com/CherryHQ/cherry-studio/blob/6b713478db0f938c346d84263e42b8d311081800/src/main/ai/tools/adapters/aiSdk/builtin/WebSearchTool.ts)
- [SearXNG search API](https://docs.searxng.org/dev/search_api.html)

## Grok integration and product evidence

TouchAI sends `POST https://api.x.ai/v1/responses` with an xAI bearer key. The
default model is `grok-4.7`, matching the current official web-search example.
General queries offer `web_search`; real-time and community queries also offer
`x_search`. Native options can select another compatible model and configure
search tools, dates, X accounts, image search and media understanding. The default
`tool_choice: "required"` requests an actual tool call. This is an API integration;
it does not use a Grok website session or a consumer subscription.

Grok produces a synthesis with citations. TouchAI extracts HTTP(S) citation URLs,
deduplicates them and uses the hostname when xAI supplies only a numeric citation
label. Optional synthesis is labeled separately from page text. xAI's deprecated
`search_parameters` / Live Search path is not used.

Two existing product implementations confirm this integration pattern:

| Product       | Public implementation evidence                                                                                                                                                  | What the evidence establishes                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cherry Studio | [PR #12812](https://github.com/CherryHQ/cherry-studio/pull/12812), merged into `main` on 2026-03-12, merge commit `2bbf09b546262e4f7489e4a7a5815d5d0e8c0bd4`; milestone v1.7.25 | Migrated from Live Search to `xai.responses(modelId)` with `xai.tools.webSearch()` and `xai.tools.xSearch()`, including X-search rendering and citations. This is search integration, beyond simply listing Grok as a chat model. |
| LobeHub       | [PR #14462](https://github.com/lobehub/lobehub/pull/14462), merged into `canary` on 2026-05-06                                                                                  | Forces xAI onto the Responses path and reuses its mapper for `web_search` and `x_search`. A merged implementation is evidence of adoption, not a live test of TouchAI or every released LobeHub version.                          |

Official contracts: [web search](https://docs.x.ai/developers/tools/web-search),
[X search](https://docs.x.ai/developers/tools/x-search),
[citations](https://docs.x.ai/developers/tools/citations), and
[Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses).
These sources support protocol compatibility. They do not establish the user's
account entitlement, network reachability, latency or result quality. No paid
xAI request was performed in this review. The configurable search timeout still
applies to the whole Grok response, including its tool use and generation.

## Yuanbao and WeChat public accounts

The Yuanbao consumer app can search WeChat public-account articles. The Tencent
Cloud API used by this integration has a different coverage contract: its
[official FAQ](https://cloud.tencent.com/document/product/1806/121804), updated
2026-10-09, states: “由于内容版权问题，元宝搜索暂不支持微信公众号内容。”

The card therefore identifies the API's limitation instead of advertising the
app's WeChat capability as available in TouchAI. A future public-account search
integration needs a documented access path with that coverage; changing the
description or adding a `site:mp.weixin.qq.com` constraint cannot establish it.

## Free allowances and billing

Rechecked on 2026-11-17. Cards summarize allowances; they do not display an
account's live remaining balance. Amounts in currency, credits and requests are
different units. The monthly account allowances below require signing up and
configuring that account's key; they do not describe anonymous shared pools.

| Provider         | Verified free allowance or billing                                                                                                | Qualification and source                                                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AnySearch        | Free access with anonymous rate limits; the card leaves the numeric allowance to the provider                                     | [Official MCP documentation](https://anysearch.com/install/mcp-install.md) confirms anonymous access. Older copy said 1,000/day; this review did not obtain a current first-party numeric quota, so it does not promise that number.                                                                   |
| Keenable         | Keyless: 1,000 requests/hour and 10/second per IP per endpoint. With a key: 100,000 requests/month per organization               | [Pricing](https://docs.keenable.ai/pricing), [rate limits](https://docs.keenable.ai/rate-limits). Search and fetch share the authenticated allowance. No card required for the free key.                                                                                                               |
| Tavily           | 1,000 API credits/month                                                                                                           | [Credits and pricing](https://docs.tavily.com/documentation/api-credits). Basic search costs one credit; advanced search costs two. [Keyless access](https://docs.tavily.com/documentation/keyless) is separately rate limited.                                                                        |
| Exa              | $10/month plus a $10 onboarding bonus                                                                                             | [Pricing](https://exa.ai/pricing). No payment method required. The card shows the recurring allowance; search type and content determine consumption.                                                                                                                                                  |
| Firecrawl        | 1,000 credits/month                                                                                                               | [Pricing](https://www.firecrawl.dev/pricing). Search and scraping draw from one balance; the base search rate is two credits per ten results, with extra costs for additional operations. This replaces older one-time 500-credit trial descriptions.                                                  |
| Brave            | $5 credit/month                                                                                                                   | [Official setup guide](https://brave.com/search/api/guides/use-with-openclaw/) and [pricing](https://brave.com/search/api/). Plan activation requires a card. The old 2,000 free requests/month label no longer represents current pricing.                                                            |
| Yuanbao          | 2,000 calls/month offered in its current access promotion                                                                         | [Tencent announcement](https://cloud.tencent.com/developer/article/2765522) explicitly advertises this amount; [billing](https://cloud.tencent.com/document/product/1806/121798) governs paid use. Account activation, selected version and current console eligibility determine actual availability. |
| Zhihu            | Daily promotional free quotas vary by account and API                                                                             | [Official quota documentation](https://developer.zhihu.com/console/docs?key=quota). `GET /api/v1/quota` returns configured daily quotas for the Access Secret; a missing quota item is not an unlimited allowance.                                                                                     |
| DeepSeek         | CNY 5 per 1,000 successful nonempty search requests                                                                               | [Official search billing](https://api-docs.deepseek.com/zh-cn/guides/search/). Fetch is charged separately at the same rate. No recurring free-search allowance was verified.                                                                                                                          |
| Grok             | Paid model tokens plus search usage; no general recurring free API allowance verified                                             | [Pricing](https://docs.x.ai/developers/models) and [X-search billing](https://docs.x.ai/developers/tools/x-search). A response may perform multiple searches; “$5/1,000 calls” is not the total cost of 1,000 TouchAI searches. A consumer Grok plan does not establish API credit.                    |
| OpenAlex         | $0.10/day without a key; $1/day with a verified free account key                                                                  | [Authentication](https://help.openalex.org/api/authentication/) and [pricing](https://help.openalex.org/access/pricing/). This replaces the old “100k free requests/day” claim. A daily dollar budget is not a fixed count of searches.                                                                |
| Semantic Scholar | Free access, with shared anonymous limits and account-specific key limits                                                         | [Official API overview](https://www.semanticscholar.org/product/api) and [tutorial](https://www.semanticscholar.org/product/api/tutorial). Do not describe a key's request-per-second allocation as an unconditional free allowance for anonymous users.                                               |
| GitHub           | No per-search fee; anonymous search 10/minute, authenticated search normally 30/minute, code search 10/minute with authentication | [Search API rate limits](https://docs.github.com/en/rest/search/search#rate-limit). The general REST limit of 60/hour is not the search endpoint's quota. Other applicable account and abuse limits still apply.                                                                                       |
| Wikipedia        | Public API, free and keyless for this endpoint                                                                                    | [OpenSearch](https://www.mediawiki.org/wiki/API:Opensearch). Fair-use and service limits still apply; no unlimited-throughput claim.                                                                                                                                                                   |
| SearXNG          | Free open-source software; user supplies an instance                                                                              | [Search API](https://docs.searxng.org/dev/search_api.html). Hosting and upstream limits are determined by that deployment.                                                                                                                                                                             |

## TouchAI strategy choices

| Strategy             | Execution                                                                                                    | Appropriate use                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Capability (default) | Choose by requested source type, optional user route, language preference, and default provider              | Routine searches where academic, code, community, official, and real-time evidence benefit from different sources |
| Model                | The model selects an available provider using its capability description; `auto` uses the configured default | Users who prefer model judgment                                                                                   |
| Intent               | Keep the existing general/academic/technical/official/news route table                                       | Existing personalized routes                                                                                      |
| Manual               | Use the configured default when the call is automatic                                                        | Predictable backend choice and billing                                                                            |
| Priority             | Try available providers in the user's order                                                                  | Predictable recovery order                                                                                        |
| Parallel             | Query the selected number of available providers, deduplicate URLs, and merge ranks with RRF                 | Broader coverage where extra calls and latency are acceptable                                                     |

Automatic fallback is separately configurable. Empty results, timeout, network
failure, HTTP 408, 429, and 5xx can advance to another provider. Deterministic
request/authentication errors stop sequential recovery. Explicit selection of an
available provider runs that provider alone. Deep mode can optionally enable
fusion independently of the everyday strategy. Disabled or unconfigured providers
are excluded from the runtime choices. Parallel count can cover all 15 providers;
the user controls how many to call.

The default capability preferences are:

| Evidence type    | Preferred sources when available                                                  |
| ---------------- | --------------------------------------------------------------------------------- |
| General          | User default and language preference                                              |
| News             | Brave; Yuanbao first for explicit Chinese preference; Grok/Tavily as alternatives |
| Community        | Zhihu, Yuanbao, AnySearch, DeepSeek                                               |
| Academic         | OpenAlex, Semantic Scholar                                                        |
| Code             | GitHub, with broad web search as fallback                                         |
| Official sources | Keenable, Yuanbao, Brave                                                          |
| Real-time        | Grok, Yuanbao, Brave                                                              |

These are configurable product defaults, not empirical rankings. Searching a code
repository is different from finding a tutorial; a caller can request another
source or explicitly choose a provider. AnySearch remains a general option and a
compatibility default, rather than being forced for every source type.

## Provider capability audit

`providerOptions` is keyed by provider. Each adapter accepts its native search
parameters; options for one engine are not forwarded to another during recovery
or fusion. It is a request-level escape hatch, not a new settings editor for every
vendor field. Native parameters cannot change HTTP credentials or the endpoint.
Where an adapter needs a particular response shape, those transport fields remain
fixed.

| Provider         | Search capabilities available in this integration                                                                                         | Native options and boundaries                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AnySearch        | General/multi-source search, news content type, time and domain constraints, answer/structured extras                                     | Native `tag`, `params`, and documented search fields. Do not label the old application limit of 50 as an official limit; upstream validation determines accepted counts.                                                                                                                                                                                      |
| Keenable         | `pro`/`realtime`, sites, exclusions, publication/index dates, point-in-time search, cards returned as result URLs                         | `snippet_max_length`, `query_time`, `acquired_*`, `published_*`, `disable_cards`, `safety_mode`, session parameters. Official search count 1–50, snippets 180–10,000 characters, exclusions up to 1,000 hosts. No application-imposed 400-character snippet cap.                                                                                              |
| Zhihu            | Global web search and Zhihu-index search; community source chooses Zhihu; filters, sort, time, authority and result metadata              | `searchType`, `Filter`, `Sort`, and endpoint-supported native fields. Global search page maximum 20, Zhihu index maximum 10. Hotlists and Zhida are separate APIs, not implemented by this search adapter.                                                                                                                                                    |
| Yuanbao          | Public/vertical/mixed search, government/news/academic/finance verticals, freshness, site filtering, picture/deeplink metadata            | `Mode`, `Industry`, `Freshness`, `Deeplinks`, `Cnt`. Counts 10/20/30/40/50; `Site` accepts one included site or at most five exclusions. Excess/mutually exclusive filters report an error instead of being discarded. Multiple included sites use query operators, subject to upstream search semantics. `content` is a dynamic summary, not full page text. |
| Grok             | Responses API `web_search` and `x_search`, citations, optional labeled synthesis, dates, X handles and media search options               | Native `model`, `tools`, and token settings. Only search tools are accepted; streaming/background storage are disabled because this adapter consumes one response. Web allowed/excluded domain lists are mutually exclusive, maximum five. X handle/date restrictions follow the X tool API. No application-imposed 1,200-token or 30-citation ceiling.       |
| Tavily           | General/news search, advanced depth, time and domain filters, optional raw content, answers and images                                    | Native topic/depth/content/answer/search fields; search page maximum 20. Keyless proxy features and paid REST availability can differ. Extract/crawl/research are separate APIs.                                                                                                                                                                              |
| Exa              | Semantic search, `auto`/`lite`/`deep`, valid content categories, date/domain filters, highlights or full text, structured output metadata | Keyed REST accepts native search options. Anonymous MCP explicitly rejects unsupported REST-only fields instead of ignoring them. Search maximum 100; search has no normal page cursor. Contents, Research/Agent, Websets, and Monitors are separate APIs.                                                                                                    |
| Brave            | Web/news/image/video search, date/language/domain filters, native country/sort/goggles/pagination options                                 | `searchType` selects the endpoint. Web count up to 20, news/video up to 50, images up to 200. Native fields remain endpoint-dependent.                                                                                                                                                                                                                        |
| Firecrawl        | Web/news/image results; optional Markdown scraping in the search request                                                                  | Native `sources`, `categories`, `scrapeOptions`, location, time, timeout, and other documented search fields; adapter default page maximum 100. Crawl/map/extract are separate APIs.                                                                                                                                                                          |
| GitHub           | Repository/issue/PR/code/commit/user/topic search, sorting and pagination                                                                 | `searchType`, `page`, `sort`, `order`, qualifiers. Page maximum 100; code search requires a token. This is search, not write access or a wrapper for every GitHub endpoint.                                                                                                                                                                                   |
| OpenAlex         | Works, abstracts, publication/language filters, citation/open-access metadata                                                             | Native filters, sort, page/cursor and fields; optional key; page maximum 200. Other entity collections are not implemented here.                                                                                                                                                                                                                              |
| Semantic Scholar | Paper search, abstracts, dates/years, fields of study, citation/open-access metadata                                                      | Native `fields`, `offset`, `year`, filters; page maximum 100 on this search endpoint. Bulk/recommendation APIs are separate.                                                                                                                                                                                                                                  |
| Wikipedia        | Chinese/English OpenSearch, namespace and native search options                                                                           | Page maximum 500. `action=opensearch` and JSON response shape stay fixed. Full page retrieval is separate.                                                                                                                                                                                                                                                    |
| SearXNG          | User's own instance, engines, categories, languages, time ranges and page number                                                          | Native `engines`, `categories`, `pageno`, etc. Available upstream capabilities depend on the instance; no global application page cap is added.                                                                                                                                                                                                               |
| DeepSeek         | Search content/summary, relevance and authority signals, date/site/exclusion operators                                                    | Native search fields including `need_content` and `count`. Official query maximum 128 characters including operators; the adapter reports excess length and keeps all filters that fit. Removed artificial eight-site and relevance-score filtering. Existing account scheduler and retries remain.                                                           |

Official references:

- [Keenable search](https://docs.keenable.ai/api-reference/search.md)
- [Zhihu developer documentation](https://developer.zhihu.com/) and its [documentation JSON](https://developer.zhihu.com/console/api/v2/docs)
- [Yuanbao SearchPro](https://cloud.tencent.com/document/product/1806/121811)
- [Grok web search](https://docs.x.ai/developers/tools/web-search) and [X search](https://docs.x.ai/developers/tools/x-search)
- [Exa search](https://docs.exa.ai/reference/search), [Tavily search](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Brave news](https://api-dashboard.search.brave.com/app/documentation/news-search/query), [images](https://api-dashboard.search.brave.com/app/documentation/image-search/query), [video](https://api-dashboard.search.brave.com/app/documentation/video-search/query)
- [Firecrawl search](https://docs.firecrawl.dev/api-reference/endpoint/search)
- [GitHub search](https://docs.github.com/en/rest/search), [OpenAlex pagination](https://docs.openalex.org/how-to-use-the-api/get-lists-of-entities/paging), [Semantic Scholar](https://api.semanticscholar.org/api-docs/graph)
- [Wikipedia OpenSearch](https://www.mediawiki.org/wiki/API:Opensearch), [DeepSeek API](https://api-docs.deepseek.com/), [AnySearch](https://anysearch.com/)

## Remaining limits and validation scope

The result limit defaults to zero (unlimited). Yuanbao and SearXNG preserve all
returned results in this mode; a positive limit still caps the list. Yuanbao
requests the largest batch its endpoint supports when no limit is set.
Each request still obeys the chosen
endpoint's page size and account rights. Native page parameters enable caller-led
pagination where supported; TouchAI does not automatically crawl every page.
Provider-native fields can override generated defaults, so callers must use the
selected endpoint's documented request schema.

The existing inline content guard remains: 8,000 characters per content/details
field and 30,000 total per formatted response, with explicit truncation/omission
markers. Search snippets are not subjected to the former Keenable 400-character
cutoff. Use `web_fetch` for full page reading. This task does not claim unlimited
model context or full coverage of every non-search vendor product.

Provider requests, parsing, routing, fallback, cancellation, fusion, settings
persistence and inline editing are covered by mocked behavior tests. Live paid
entitlements and provider result quality require credentialed integration tests.
Native UI evidence and the validation status for a submitted revision belong in
its pull request. Release performance budgets still require measurements on a
fixed device and build profile.
