# 更新日志

## [1.3.0](https://github.com/TouchAI-org/TouchAI/compare/v1.2.0...v1.3.0) (2026-06-12)


### Features

* add application i18n ([#240](https://github.com/TouchAI-org/TouchAI/issues/240)) ([e4403db](https://github.com/TouchAI-org/TouchAI/commit/e4403db005f739e2a8f9c95b254b864993f0624c))
* add session status reminders ([#217](https://github.com/TouchAI-org/TouchAI/issues/217)) ([80b0ecc](https://github.com/TouchAI-org/TouchAI/commit/80b0ecc4df2b5933b091e4a10117e0ba81a975d9))
* add update policy deployment and blocking ([#235](https://github.com/TouchAI-org/TouchAI/issues/235)) ([dc6ccd8](https://github.com/TouchAI-org/TouchAI/commit/dc6ccd87d71c8e2fd0191ef96486071c8761e69f))
* **ai-services:** promote MiMo with gold badge and collapse other providers ([#283](https://github.com/TouchAI-org/TouchAI/issues/283)) ([e3086f4](https://github.com/TouchAI-org/TouchAI/commit/e3086f4fb5531be80c8b4ab708923d397864096a))
* **browser:** add web search and browser-grounded automation ([#444](https://github.com/TouchAI-org/TouchAI/issues/444)) ([7ee73d1](https://github.com/TouchAI-org/TouchAI/commit/7ee73d13c69170c814e209d6e75cc74ce7059ae1))
* **desktop:** add TouchAI Hub managed mimo access ([#375](https://github.com/TouchAI-org/TouchAI/issues/375)) ([465d2ab](https://github.com/TouchAI-org/TouchAI/commit/465d2abe48fd072c723607e7181c5ec264b502c6))
* **desktop:** ship updater release pipeline ([#270](https://github.com/TouchAI-org/TouchAI/issues/270)) ([7e458d7](https://github.com/TouchAI-org/TouchAI/commit/7e458d704cc94762f5c14485e7755fab95d3d4a0))
* **desktop:** unify ask-user UI for approval/confirm/question ([#26](https://github.com/TouchAI-org/TouchAI/issues/26)) ([#301](https://github.com/TouchAI-org/TouchAI/issues/301)) ([41c2d94](https://github.com/TouchAI-org/TouchAI/commit/41c2d94d8f26c420568f9c507060e13b8b6a85b6))
* make MiMo the default provider, disable others ([#313](https://github.com/TouchAI-org/TouchAI/issues/313)) ([c27f7fe](https://github.com/TouchAI-org/TouchAI/commit/c27f7fe5237b911f4c9966a2abeea060a3054e52))
* **notification:** adjust approval reminder notification behavior ([#384](https://github.com/TouchAI-org/TouchAI/issues/384)) ([75b93d8](https://github.com/TouchAI-org/TouchAI/commit/75b93d82a6cf1963fe2169a909b3c40cf2653cd0))
* **release:** publish cross-platform desktop update pipeline ([#247](https://github.com/TouchAI-org/TouchAI/issues/247)) ([dcaa8f5](https://github.com/TouchAI-org/TouchAI/commit/dcaa8f512ee3c26fd1b9dd1c0e8760aa7adea280))
* **settings:** redesign settings window ([#249](https://github.com/TouchAI-org/TouchAI/issues/249)) ([cca66fd](https://github.com/TouchAI-org/TouchAI/commit/cca66fd1a3983f9586c263bc4a33fd50b6f21dcb))


### Bug Fixes

* **agent-service:** avoid ambiguous tool log restore ([#322](https://github.com/TouchAI-org/TouchAI/issues/322)) ([c63e4d5](https://github.com/TouchAI-org/TouchAI/commit/c63e4d52458dc360edd28b1a764fd4be2d4bb090))
* **agent-service:** guard missing tool results ([#318](https://github.com/TouchAI-org/TouchAI/issues/318)) ([f0bd14d](https://github.com/TouchAI-org/TouchAI/commit/f0bd14d9d9bf8f6226dae3566b9c271d605e559f))
* **agent-service:** preserve network errors when provider classification fails ([#411](https://github.com/TouchAI-org/TouchAI/issues/411)) ([36044b6](https://github.com/TouchAI-org/TouchAI/commit/36044b6df0ff89b43c07e2585794728f41567a30))
* **agent-service:** preserve request errors during auth cleanup ([#448](https://github.com/TouchAI-org/TouchAI/issues/448)) ([ee1f698](https://github.com/TouchAI-org/TouchAI/commit/ee1f698ff76fbc7bd09104439087b5fc114d032f))
* **agent-service:** refresh model metadata on startup ([#383](https://github.com/TouchAI-org/TouchAI/issues/383)) ([fcb3cd9](https://github.com/TouchAI-org/TouchAI/commit/fcb3cd9c9afaf7dcf8d4d02693e8b55dc1937a05))
* **agent-service:** show friendly unsupported input errors ([#407](https://github.com/TouchAI-org/TouchAI/issues/407)) ([b35f7ce](https://github.com/TouchAI-org/TouchAI/commit/b35f7ce2ec26b368090a00faf6e13a00eebe3c4b))
* **agent:** abort stale startup requests ([#326](https://github.com/TouchAI-org/TouchAI/issues/326)) ([8b6d830](https://github.com/TouchAI-org/TouchAI/commit/8b6d8306a8487f841f6762910275cebf15109ad6))
* **agent:** classify localized cancellation errors ([#339](https://github.com/TouchAI-org/TouchAI/issues/339)) ([c3d675e](https://github.com/TouchAI-org/TouchAI/commit/c3d675ee5b21ca17a2f98223d4ae02e2776808ec))
* **agent:** preserve reasoning-only assistant messages ([#266](https://github.com/TouchAI-org/TouchAI/issues/266)) ([e03f1db](https://github.com/TouchAI-org/TouchAI/commit/e03f1dbd26574de58f6e1892d753b5c95a7d566e))
* **agent:** sync switched model on active reattach ([#366](https://github.com/TouchAI-org/TouchAI/issues/366)) ([1ddc767](https://github.com/TouchAI-org/TouchAI/commit/1ddc767d81451377cd8e5161c1a12c4075a49791))
* **ai-sdk:** retain streamed tool call names ([#362](https://github.com/TouchAI-org/TouchAI/issues/362)) ([eb372b1](https://github.com/TouchAI-org/TouchAI/commit/eb372b18708778a031f8a71fb81a9d920232db3c))
* **ask-user:** notify background questions ([#314](https://github.com/TouchAI-org/TouchAI/issues/314)) ([3bba9af](https://github.com/TouchAI-org/TouchAI/commit/3bba9af5164a6c1d4f42bd1ad6fd2e134119a3e9))
* **database:** avoid case update when switching default model ([#254](https://github.com/TouchAI-org/TouchAI/issues/254)) ([c8e21a6](https://github.com/TouchAI-org/TouchAI/commit/c8e21a641db950e98241106795ba9a40071baec6))
* **database:** use precise model metadata matching to avoid unrelated prefix collisions ([#353](https://github.com/TouchAI-org/TouchAI/issues/353)) ([6096ab1](https://github.com/TouchAI-org/TouchAI/commit/6096ab109461ee5175bffb75d91f403f6b286825))
* **desktop-search:** honor auto-shrink after tray reopen ([#269](https://github.com/TouchAI-org/TouchAI/issues/269)) ([704deae](https://github.com/TouchAI-org/TouchAI/commit/704deae528b09fa1e3fdc842cf398c61af5c59c4))
* **desktop:** add missing fs ACL permissions for Read tool ([#305](https://github.com/TouchAI-org/TouchAI/issues/305)) ([9b9fba1](https://github.com/TouchAI-org/TouchAI/commit/9b9fba1c7a53e38152f281a55cccb7c589d2b757))
* **desktop:** add win10 rounded corner fallback ([#403](https://github.com/TouchAI-org/TouchAI/issues/403)) ([4517de8](https://github.com/TouchAI-org/TouchAI/commit/4517de8cab416437de4176ec4332f4f9deb51061))
* **desktop:** avoid blocking updater download freezes ([#248](https://github.com/TouchAI-org/TouchAI/issues/248)) ([2270e01](https://github.com/TouchAI-org/TouchAI/commit/2270e0174e42b3f5aee457bb4093e06a1931ed69))
* **desktop:** cache browser discovery in settings ([#453](https://github.com/TouchAI-org/TouchAI/issues/453)) ([0106912](https://github.com/TouchAI-org/TouchAI/commit/010691238ed25c4685245153302de7990de7eb36))
* **desktop:** improve cold startup first paint ([#401](https://github.com/TouchAI-org/TouchAI/issues/401)) ([1dd33ca](https://github.com/TouchAI-org/TouchAI/commit/1dd33cae8e54be364f2af05e2f801becbd733bf4))
* **desktop:** improve font loading diagnostics ([#405](https://github.com/TouchAI-org/TouchAI/issues/405)) ([e425600](https://github.com/TouchAI-org/TouchAI/commit/e425600f9dc64978f13c2353fac1f98a8a3513de))
* **desktop:** invalidate MiMo managed auth on bare 401 ([#408](https://github.com/TouchAI-org/TouchAI/issues/408)) ([6199d1c](https://github.com/TouchAI-org/TouchAI/commit/6199d1c65879b9fdca2257b405f627f37df4fa1a))
* **desktop:** make font loading deterministic ([#392](https://github.com/TouchAI-org/TouchAI/issues/392)) ([7aef4f7](https://github.com/TouchAI-org/TouchAI/commit/7aef4f7f55c07f4b8c51074a467836e1aba38801))
* **desktop:** preserve generated visualization styling ([#387](https://github.com/TouchAI-org/TouchAI/issues/387)) ([edac12c](https://github.com/TouchAI-org/TouchAI/commit/edac12ccdc66d6e21b1de2b3709f17f33e427ec1))
* **desktop:** preserve message bubble line breaks ([#412](https://github.com/TouchAI-org/TouchAI/issues/412)) ([691b23a](https://github.com/TouchAI-org/TouchAI/commit/691b23a1fc8b3141887fc80104699b2a6f85ff93))
* **desktop:** prevent shell vars from rendering as math ([#419](https://github.com/TouchAI-org/TouchAI/issues/419)) ([bd98f76](https://github.com/TouchAI-org/TouchAI/commit/bd98f76b1fbf99c71879e847ef3d8e2502babca7))
* **desktop:** stabilize search window border resize ([#345](https://github.com/TouchAI-org/TouchAI/issues/345)) ([0400a46](https://github.com/TouchAI-org/TouchAI/commit/0400a4657dabd66e64cb80e897fa64fe148ca2dc))
* **linux:** stabilize tray indicator registration ([#285](https://github.com/TouchAI-org/TouchAI/issues/285)) ([e94ae75](https://github.com/TouchAI-org/TouchAI/commit/e94ae75db426681a0cc33f8d97e739532ad3e6fd))
* **markdown:** keep renderer mounted on final output ([#420](https://github.com/TouchAI-org/TouchAI/issues/420)) ([8287c9d](https://github.com/TouchAI-org/TouchAI/commit/8287c9da3637d0cd19fe31d3854402e319b5ca45))
* **models:** avoid prefix metadata matches ([#337](https://github.com/TouchAI-org/TouchAI/issues/337)) ([8eb5cdf](https://github.com/TouchAI-org/TouchAI/commit/8eb5cdfef70599c2857087e8dcb37c7bf870a4a6))
* **quicksearch:** reset context menu close state ([#324](https://github.com/TouchAI-org/TouchAI/issues/324)) ([3c3b10e](https://github.com/TouchAI-org/TouchAI/commit/3c3b10e0b729e1631287a7c601bf3c64a1141929))
* **release:** attach public assets to GitHub releases ([#274](https://github.com/TouchAI-org/TouchAI/issues/274)) ([8aec745](https://github.com/TouchAI-org/TouchAI/commit/8aec745108ed3bc9a336284fb2f4360e50977c13))
* **release:** handle full-object update proxy responses ([#278](https://github.com/TouchAI-org/TouchAI/issues/278)) ([ec0cff1](https://github.com/TouchAI-org/TouchAI/commit/ec0cff1ffadc60ad24356bda5e02b3c5ff844e3a))
* **release:** include update notes and downloads ([#242](https://github.com/TouchAI-org/TouchAI/issues/242)) ([3c995ee](https://github.com/TouchAI-org/TouchAI/commit/3c995eeaf5cad2b1d18737599caaf6cbe1ffec13))
* **release:** publish channel latest metadata ([#241](https://github.com/TouchAI-org/TouchAI/issues/241)) ([df79fbe](https://github.com/TouchAI-org/TouchAI/commit/df79fbe2b6df9830266a9cd568e170dfed5857de))
* **release:** remove conflicting Velopack installer flag ([#273](https://github.com/TouchAI-org/TouchAI/issues/273)) ([f41e18e](https://github.com/TouchAI-org/TouchAI/commit/f41e18e9c80928106696fa531a2b74e441376921))
* **scheduler:** clone reactive trigger input ([#328](https://github.com/TouchAI-org/TouchAI/issues/328)) ([38dbe35](https://github.com/TouchAI-org/TouchAI/commit/38dbe35be31e7fbaeb06c66ed6c1afd9fac126c9))
* **search:** add click stats conflict index ([#341](https://github.com/TouchAI-org/TouchAI/issues/341)) ([d9bc577](https://github.com/TouchAI-org/TouchAI/commit/d9bc577fcf923aeb30478d8ff8b9e9f5c1b437bf))
* **search:** center single-line search bar content ([#399](https://github.com/TouchAI-org/TouchAI/issues/399)) ([04650bb](https://github.com/TouchAI-org/TouchAI/commit/04650bb93b4d6a17efbbc986dc75d7ce30374b89))
* **search:** ignore stale surface shown events ([#332](https://github.com/TouchAI-org/TouchAI/issues/332)) ([2e0c790](https://github.com/TouchAI-org/TouchAI/commit/2e0c79079989b8374d551bc433cbd58548be73f7))
* **search:** keep SearchView resize in sync during multiline input ([#272](https://github.com/TouchAI-org/TouchAI/issues/272)) ([7df5763](https://github.com/TouchAI-org/TouchAI/commit/7df5763fb2e25b695d37ce2ae63ec98b3366a86d))
* **search:** remeasure window height on activation ([#382](https://github.com/TouchAI-org/TouchAI/issues/382)) ([d71a223](https://github.com/TouchAI-org/TouchAI/commit/d71a22310839a2003bbe88d553cf70f2447bd9e3))
* **search:** stabilize multiline input layout and preserve empty-line caret ([#282](https://github.com/TouchAI-org/TouchAI/issues/282)) ([3f809a3](https://github.com/TouchAI-org/TouchAI/commit/3f809a339956ad592dc5af6e0a12236f7b042c3a))
* **search:** stabilize quick search state on first summon ([#231](https://github.com/TouchAI-org/TouchAI/issues/231)) ([39a4862](https://github.com/TouchAI-org/TouchAI/commit/39a486225454cd408a8eebe6237ec051bafaa568))
* **sessions:** retain provider during metadata refresh ([#360](https://github.com/TouchAI-org/TouchAI/issues/360)) ([792512b](https://github.com/TouchAI-org/TouchAI/commit/792512b96dc18b185f12647a4f86558a5a6f0b47))
* **settings:** polish update details copy ([#286](https://github.com/TouchAI-org/TouchAI/issues/286)) ([74ef649](https://github.com/TouchAI-org/TouchAI/commit/74ef64990a56bb5f2d83bc13378d56ed6970f1a5))
* **settings:** roll back failed setting updates ([#334](https://github.com/TouchAI-org/TouchAI/issues/334)) ([e083061](https://github.com/TouchAI-org/TouchAI/commit/e083061c85e59ab4ad5a977133524b6021516e08))
* **settings:** stabilize settings updates ([#258](https://github.com/TouchAI-org/TouchAI/issues/258)) ([e692047](https://github.com/TouchAI-org/TouchAI/commit/e692047eb339b8331d3110caeed6f23dc95f0903))
* **settings:** wrap MCP log search input ([#354](https://github.com/TouchAI-org/TouchAI/issues/354)) ([783a3bc](https://github.com/TouchAI-org/TouchAI/commit/783a3bc4e53f3fa77032b6eeb5265bfcab4a2dee))
* **tauri:** finish macOS reminder objc2 migration ([#369](https://github.com/TouchAI-org/TouchAI/issues/369)) ([3800037](https://github.com/TouchAI-org/TouchAI/commit/3800037c98744b2d153cb3835f610a6735dce7ec))
* **tauri:** migrate macOS reminder delegate to objc2 0.6 ([#368](https://github.com/TouchAI-org/TouchAI/issues/368)) ([ea2a95a](https://github.com/TouchAI-org/TouchAI/commit/ea2a95a35f74efc04eff3ae16d43311056c8d53f))
* **updater:** avoid wrong-platform downloads ([#364](https://github.com/TouchAI-org/TouchAI/issues/364)) ([0f1c431](https://github.com/TouchAI-org/TouchAI/commit/0f1c431b08f3b7301035bffd58b38f062ce57a51))
* **updater:** ignore stale download progress ([#311](https://github.com/TouchAI-org/TouchAI/issues/311)) ([023221f](https://github.com/TouchAI-org/TouchAI/commit/023221f8074486fa8cd517328f0678866e3dc198))
* **updater:** ignore stale download results ([#315](https://github.com/TouchAI-org/TouchAI/issues/315)) ([23e6655](https://github.com/TouchAI-org/TouchAI/commit/23e6655e2a9a57ab488468da3ad72c9f4317cead))
* **updater:** keep checks responsive and clean up before install ([#253](https://github.com/TouchAI-org/TouchAI/issues/253)) ([ba21c6c](https://github.com/TouchAI-org/TouchAI/commit/ba21c6c6025e436dc09af43f6507f56e8bbcee16))
* **webfetch:** block private mapped ipv6 hosts ([#280](https://github.com/TouchAI-org/TouchAI/issues/280)) ([4980ea6](https://github.com/TouchAI-org/TouchAI/commit/4980ea63acdc0b25ff8344d7a44a30abed1cf242))
* **webfetch:** validate redirect targets ([#306](https://github.com/TouchAI-org/TouchAI/issues/306)) ([4e637a9](https://github.com/TouchAI-org/TouchAI/commit/4e637a992dbdfadcbf72f4e053518e164235fd62))
* **widget:** render Chart.js widget initializers ([#344](https://github.com/TouchAI-org/TouchAI/issues/344)) ([fac5f0b](https://github.com/TouchAI-org/TouchAI/commit/fac5f0b98665e30740c4ccd11e47510c58ca6934))
* **widget:** sanitize innerHTML with DOMPurify to prevent XSS ([#310](https://github.com/TouchAI-org/TouchAI/issues/310)) ([af12194](https://github.com/TouchAI-org/TouchAI/commit/af12194bb4680be99db446e3ea85926bc25ff4e2))

## [1.2.0](https://github.com/TouchAI-org/TouchAI/compare/v1.1.1...v1.2.0) (2026-06-10)


### Features

* **browser:** add web search and browser-grounded automation ([#444](https://github.com/TouchAI-org/TouchAI/issues/444)) ([7ee73d1](https://github.com/TouchAI-org/TouchAI/commit/7ee73d13c69170c814e209d6e75cc74ce7059ae1))


### Bug Fixes

* **agent-service:** preserve request errors during auth cleanup ([#448](https://github.com/TouchAI-org/TouchAI/issues/448)) ([ee1f698](https://github.com/TouchAI-org/TouchAI/commit/ee1f698ff76fbc7bd09104439087b5fc114d032f))
* **desktop:** cache browser discovery in settings ([#453](https://github.com/TouchAI-org/TouchAI/issues/453)) ([0106912](https://github.com/TouchAI-org/TouchAI/commit/010691238ed25c4685245153302de7990de7eb36))

## [1.1.1](https://github.com/TouchAI-org/TouchAI/compare/v1.1.0...v1.1.1) (2026-06-08)


### Bug Fixes

* **agent-service:** preserve network errors when provider classification fails ([#411](https://github.com/TouchAI-org/TouchAI/issues/411)) ([36044b6](https://github.com/TouchAI-org/TouchAI/commit/36044b6df0ff89b43c07e2585794728f41567a30))
* **agent:** classify localized cancellation errors ([#339](https://github.com/TouchAI-org/TouchAI/issues/339)) ([c3d675e](https://github.com/TouchAI-org/TouchAI/commit/c3d675ee5b21ca17a2f98223d4ae02e2776808ec))
* **agent:** sync switched model on active reattach ([#366](https://github.com/TouchAI-org/TouchAI/issues/366)) ([1ddc767](https://github.com/TouchAI-org/TouchAI/commit/1ddc767d81451377cd8e5161c1a12c4075a49791))
* **ai-sdk:** retain streamed tool call names ([#362](https://github.com/TouchAI-org/TouchAI/issues/362)) ([eb372b1](https://github.com/TouchAI-org/TouchAI/commit/eb372b18708778a031f8a71fb81a9d920232db3c))
* **desktop:** invalidate MiMo managed auth on bare 401 ([#408](https://github.com/TouchAI-org/TouchAI/issues/408)) ([6199d1c](https://github.com/TouchAI-org/TouchAI/commit/6199d1c65879b9fdca2257b405f627f37df4fa1a))
* **desktop:** preserve message bubble line breaks ([#412](https://github.com/TouchAI-org/TouchAI/issues/412)) ([691b23a](https://github.com/TouchAI-org/TouchAI/commit/691b23a1fc8b3141887fc80104699b2a6f85ff93))
* **desktop:** prevent shell vars from rendering as math ([#419](https://github.com/TouchAI-org/TouchAI/issues/419)) ([bd98f76](https://github.com/TouchAI-org/TouchAI/commit/bd98f76b1fbf99c71879e847ef3d8e2502babca7))
* **markdown:** keep renderer mounted on final output ([#420](https://github.com/TouchAI-org/TouchAI/issues/420)) ([8287c9d](https://github.com/TouchAI-org/TouchAI/commit/8287c9da3637d0cd19fe31d3854402e319b5ca45))
* **sessions:** retain provider during metadata refresh ([#360](https://github.com/TouchAI-org/TouchAI/issues/360)) ([792512b](https://github.com/TouchAI-org/TouchAI/commit/792512b96dc18b185f12647a4f86558a5a6f0b47))
* **webfetch:** validate redirect targets ([#306](https://github.com/TouchAI-org/TouchAI/issues/306)) ([4e637a9](https://github.com/TouchAI-org/TouchAI/commit/4e637a992dbdfadcbf72f4e053518e164235fd62))

## [1.1.0](https://github.com/TouchAI-org/TouchAI/compare/v1.0.0...v1.1.0) (2026-06-03)


### Features

* **notification:** adjust approval reminder notification behavior ([#384](https://github.com/TouchAI-org/TouchAI/issues/384)) ([75b93d8](https://github.com/TouchAI-org/TouchAI/commit/75b93d82a6cf1963fe2169a909b3c40cf2653cd0))


### Bug Fixes

* **agent-service:** refresh model metadata on startup ([#383](https://github.com/TouchAI-org/TouchAI/issues/383)) ([fcb3cd9](https://github.com/TouchAI-org/TouchAI/commit/fcb3cd9c9afaf7dcf8d4d02693e8b55dc1937a05))
* **agent-service:** show friendly unsupported input errors ([#407](https://github.com/TouchAI-org/TouchAI/issues/407)) ([b35f7ce](https://github.com/TouchAI-org/TouchAI/commit/b35f7ce2ec26b368090a00faf6e13a00eebe3c4b))
* **desktop:** add win10 rounded corner fallback ([#403](https://github.com/TouchAI-org/TouchAI/issues/403)) ([4517de8](https://github.com/TouchAI-org/TouchAI/commit/4517de8cab416437de4176ec4332f4f9deb51061))
* **desktop:** improve cold startup first paint ([#401](https://github.com/TouchAI-org/TouchAI/issues/401)) ([1dd33ca](https://github.com/TouchAI-org/TouchAI/commit/1dd33cae8e54be364f2af05e2f801becbd733bf4))
* **desktop:** improve font loading diagnostics ([#405](https://github.com/TouchAI-org/TouchAI/issues/405)) ([e425600](https://github.com/TouchAI-org/TouchAI/commit/e425600f9dc64978f13c2353fac1f98a8a3513de))
* **desktop:** make font loading deterministic ([#392](https://github.com/TouchAI-org/TouchAI/issues/392)) ([7aef4f7](https://github.com/TouchAI-org/TouchAI/commit/7aef4f7f55c07f4b8c51074a467836e1aba38801))
* **desktop:** preserve generated visualization styling ([#387](https://github.com/TouchAI-org/TouchAI/issues/387)) ([edac12c](https://github.com/TouchAI-org/TouchAI/commit/edac12ccdc66d6e21b1de2b3709f17f33e427ec1))
* **search:** center single-line search bar content ([#399](https://github.com/TouchAI-org/TouchAI/issues/399)) ([04650bb](https://github.com/TouchAI-org/TouchAI/commit/04650bb93b4d6a17efbbc986dc75d7ce30374b89))
* **search:** remeasure window height on activation ([#382](https://github.com/TouchAI-org/TouchAI/issues/382)) ([d71a223](https://github.com/TouchAI-org/TouchAI/commit/d71a22310839a2003bbe88d553cf70f2447bd9e3))

## [1.0.0](https://github.com/TouchAI-org/TouchAI/compare/v0.1.0...v1.0.0) (2026-06-02)

<p align="center">
  <img src="/docs/images/touchai-mimo.png" alt="TouchAI × 小米 MIMO" />
</p>

> 2026 年 6 月 1 日至 6 月 14 日，**小米 MiMo 为 TouchAI 提供限免 Tokens 支持**。活动期间，MiMo 设为默认模型提供商，授权即用，轻松体验。

---

经过半年的密集开发，我们很高兴地宣布 **TouchAI 1.0.0** 正式发布！我们定义它为下一代桌面效率Agent，专为提升你的Agent使用效率设计。

## ✨ 核心亮点

### **1. 一触即达，不打断工作流**
- **全局快捷键唤起**：`Alt+Space` 召之即来挥之即去，AI 始终在你身边。
- **全键盘操作**：无需鼠标，纯键盘即可完成所有交互。
- **智能窗口伸缩**：输入时小巧不遮挡，响应时自动展开，始终处于最佳位置。

### **2. 桌面上下文，更懂你的需求**
- **文件感知**：智能识别当前桌面文件、剪贴板、窗口等上下文信息。
- **附件投递**：支持拖拽/粘贴文件附件，AI 直接读取并理解内容。
- **文件检索**：内置 ripgrep，支持连接Everything，轻松检索全机。

### **3. 从对话到执行，真正“有用”的桌面 Agent**
- **真实工具调用**：不只是聊天，TouchAI 能直接操作文件、执行命令、检索信息。
- **内置精简工具**：文件读写、Bash 执行、网页浏览、文件搜索、可视化等。
- **可视化交互 UI**：Widget 渲染引擎支持图表、流程图等丰富可视化内容。

### **4. 灵活的模型与扩展**
- **BYOK 支持**：自带 API 密钥，无厂商锁定，自由切换服务商。
- **MCP 支持**：连接更广阔的工具生态，无限扩展 Agent 能力。

---

## 📍 功能预告

v1.0.0 只是开始。接下来我们将继续重磅增强 Agent 能力：

- **Skills** — 技能市场，按需安装，扩展 Agent 能力边界
- **CDP（Chrome DevTools Protocol）** — 深度浏览器控制与自动化
- **Computer Use** — 桌面操作自动化，AI 直接操控你的电脑
- **记忆系统** — 长期记忆与个性化上下文，越用越懂你
- **MiniApp 生态** — 更丰富的可视化应用与交互体验
- **自动化工作流** — 定时任务与触发器编排，解放重复劳动

更多能力持续开放中，敬请期待，也欢迎更多朋友参与贡献！

---

## 🙏 特别致谢

感谢所有为 TouchAI v1.0.0 做出贡献的开发者：

**核心维护者：** @hiqiancheng

**社区贡献：** @ThunderTr77, @sakukae, @TheEverests, @jiang171, @ARCJ137442, @velga111, @CelesteLP, @cjc0013, @icy-bean, @snowjuly, @xlocalvn-svg, @karry-083

---

## 📥 立即体验

**下载地址：** [GitHub Releases](https://github.com/TouchAI-org/TouchAI/releases)

**系统要求：**
- Windows 10/11
- macOS 12+
- Linux（Ubuntu 20.04+, Fedora 35+）

---

## 💬 反馈与支持

如有任何疑问、建议或问题：
- 提交 [Issue](https://github.com/TouchAI-org/TouchAI/issues)
- 前往 [TouchAI × Mimo 反馈专贴](https://github.com/TouchAI-org/TouchAI/discussions/348) 反馈

---

# Changelog

## [1.0.0](https://github.com/TouchAI-org/TouchAI/compare/v0.1.0...v1.0.0) (2026-06-02)

<p align="center">
  <img src="/docs/images/touchai-mimo.png" alt="TouchAI × Xiaomi MiMo" />
</p>

> From **June 1 to June 14, 2026**, **Xiaomi MiMo offers complimentary token support for TouchAI**. During the event period, MiMo will be set as the default model provider — simply authorize and start using it for a seamless experience.

---

After six months of intensive development, we are thrilled to announce the official release of **TouchAI v1.0.0**! We define it as the next-generation desktop productivity Agent, purpose-built to supercharge your Agent workflow.

## ✨ Highlights

### **1. One-Touch Access, Zero Workflow Interruption**
- **Global hotkey activation**: `Alt+Space` — summon and dismiss instantly. AI is always within reach.
- **Full keyboard control**: Complete every interaction with your keyboard alone, no mouse required.
- **Smart window resizing**: Compact when you're typing so it never blocks your work, auto-expands when the response is ready, always in the optimal position.

### **2. Desktop Context, Smarter Responses**
- **File awareness**: Intelligently detects current desktop files, clipboard content, active windows, and other contextual information.
- **Attachment drop-off**: Drag-and-drop or paste file attachments; the AI reads and understands the content directly.
- **File search**: Built-in ripgrep and Everything integration for lightning-fast full-machine search.

### **3. From Conversation to Execution — A Truly "Useful" Desktop Agent**
- **Real tool calls**: Not just a chatbot — TouchAI operates files, executes commands, and retrieves information directly.
- **Built-in lightweight tools**: File read/write, Bash execution, web browsing, file search, visualization, and more.
- **Interactive visual UI**: The Widget rendering engine supports rich visualizations including charts, flowcharts, and more.

### **4. Flexible Models & Extensions**
- **BYOK (Bring Your Own Key)**: Bring your own API key — no vendor lock-in, freely switch between providers.
- **MCP support**: Connect to a broader ecosystem of tools, infinitely extend your Agent's capabilities.

## 📍 What's Coming Next

v1.0.0 is just the beginning. We will continue to massively enhance Agent capabilities:

- **Skills** — A skill marketplace: install on demand to extend the boundaries of your Agent.
- **CDP (Chrome DevTools Protocol)** — Deep browser control and automation.
- **Computer Use** — Desktop automation, letting AI directly control your computer.
- **Memory System** — Long-term memory and personalized context, getting smarter the more you use it.
- **MiniApp Ecosystem** — Richer visual apps and interactive experiences.
- **Automation Workflows** — Scheduled tasks and trigger orchestration to eliminate repetitive work.

More capabilities are continuously rolling out — stay tuned! Contributions from the community are always welcome.

---

## 🙏 Special Thanks

A heartfelt thank-you to everyone who contributed to TouchAI v1.0.0:

**Core Maintainer:** @hiqiancheng

**Community Contributors:** @ThunderTr77, @sakukae, @TheEverests, @jiang171, @ARCJ137442, @velga111, @CelesteLP, @cjc0013, @icy-bean, @snowjuly, @xlocalvn-svg, @karry-083

---

## 📥 Get It Now

**Download:** [GitHub Releases](https://github.com/TouchAI-org/TouchAI/releases)

**System Requirements:**
- Windows 10/11
- macOS 12+
- Linux (Ubuntu 20.04+, Fedora 35+)

---

## 💬 Feedback & Support

For any questions, suggestions, or issues:
- Submit an [Issue](https://github.com/TouchAI-org/TouchAI/issues)
- Visit [TouchAI × MiMo Feedback Thread](https://github.com/TouchAI-org/TouchAI/discussions/348)

---

**TouchAI v1.0.0 — Not just conversation, but action.**

[Download Now](https://github.com/TouchAI-org/TouchAI/releases) · [Open Source](https://github.com/TouchAI-org/TouchAI) · [Feedback](https://github.com/TouchAI-org/TouchAI/discussions/348)
