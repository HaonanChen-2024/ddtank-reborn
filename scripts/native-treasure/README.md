# Original Treasure Hunting core candidate

Current combined packaging: the Purr batch adds four fixed resources to the previous Treasure package, producing 45 assets/40 build-source pins with 24 common and 35 module callbacks. The earlier 41-resource A01 freeze below is retained as historical evidence. The real-SWF isolated 6→18→41→45 upgrade and complete owned rollback pass without changing 14 live inputs. No client runtime or deployment is implied.

Experimental A01 core slice, built offline. This module keeps the reference `treasureHunting` main window, category cells, temporary bag, prize preview, RecordViewUI layout and reward animation. It does not start a service, access a player database, open the client or deploy resources. Original full/cross-server ranks, rank rewards, paid tickets and the other original categories remain pending; this is not completion of all A01 functionality.

## Reproducible inputs

The anonymous public version index supplies the exact `treasurehunting_v3_6_1_u1.swf` and `.ui` LoadNames. `StartupResourceLoader` supplies the exact `/Request/NewLotteryItem.xml` path. The original files and HTTP receipts remain in `runtime/reference-activities-completion-20261014/native-maze-analysis-20261015/` outside Git. Catalog contents are reference evidence only and are never loaded as the local prize pool, prices or equipment properties.

| Input | SHA-256 |
| --- | --- |
| Original business core `2_v3_6_1_u9.png` | `af361678887e2413efe54e6cd86d37426cc6724ea964080178eea4816a785ae4` |
| Original art SWF, 580366 bytes | `8929462943c1da24ae6f6e546120c278306012c24d99a9767f3fb3ce2187ff7f` |
| Original Morn UI, 2848 bytes | `f18f82547d7427eb4681d54f38abbbc212bf1a412e434e6728003883c3ba3dd9` |
| Original zlib catalog, 965 bytes | `739530d89d7802ad8ce641627b72a1b6207bbec49044ea9035e495f1a35e285b` |
| Original `treasureHunting.xml` ZIP entry, 18414 bytes | `62e0a05b29e5335107195b339061a69ecbedb27105e59a7a79f257f7f799ce79` |

`catalog.mjs` now prepares the complete original directory: 158 ordered rows,
157 templates, 14 selectable categories and the special category 15. Row keys
combine the decoded source SHA and row number; repeated original IDs and the
two differently counted `11905` rows remain separate. `prepare-catalog.mjs`
writes an immutable offline catalog and display-identity report:

```powershell
& '..\..\runtime\tools\node-v24.21.0-win-x64\node.exe' scripts/native-treasure/prepare-catalog.mjs DISPLAY_INPUTS_JSON NEW_OUTPUT_DIRECTORY
& '..\..\runtime\tools\node-v24.21.0-win-x64\node.exe' --test scripts/native-treasure/catalog.test.mjs
```

The input contains `referenceTemplates`, `localTemplates` and two
`templateSources` (`reference-snapshot` / `local-snapshot`, each with path and
SHA-256). Only `TemplateID`, `CategoryID`, `Pic` and `NeedSex` reach the report;
the caller must separately verify their derivation from the pinned XML.
Same-number display conflicts remain blocked even when another local ID has
matching display fields. Such candidates do not establish matching effects,
official attributes or item semantics. Neither the catalog nor the report is
a live prize pool or permission to deliver an item. Completing the original
pool still requires missing-template/resource resolution, official equipment
attributes, delivery preflight and synchronized server/native-client rules.
Existing installed manifests, source pins and four-material gameplay remain
unchanged by this offline preparation command.

An optional `weaponInputs` object adds a `weapon-mappings.json` report through
the same preparation command. It contains `localTemplates` with the four display
fields plus `Attack`, `Defence`, `Agility`, `Luck` and `Property1` through
`Property8`, and an explicit `mappings` array of
`{sourceTemplateId, localTemplateId}`. An empty array preserves every local
mapping as unresolved; neither the same ID nor the same picture selects one.
Full local rows must agree with the supplied local display snapshot, and their
XML derivation still needs independent verification.

`weapon-catalog.mjs` pins the saved 2026-10-12 official DIY catalog and all six
original response pages, verifies their receipts, pagination and ordered
records, and selects official fields only by the original weapon ID. The
saved snapshot covers 12 of the original 15 weapon IDs; the other three remain
missing. The pure resolver accepts caller data for offline analysis; only the
preparation command's pinned loader verifies official snapshot provenance.
An explicit mapping with different display or any of the 12 fields remains a
conflict. Accepted field mappings are still proposals: they do not install or
rewrite old templates, enable rewards, or prove BallConfig, physics, resources
or in-game effects. Actual installation continues to belong to
`scripts/workshop-weapon.ts` with complete item and projectile packages.

```powershell
& '..\..\runtime\tools\node-v24.21.0-win-x64\node.exe' --test scripts/native-treasure/catalog.test.mjs scripts/native-treasure/weapon-catalog.test.mjs
```

`extract-resources.mjs` decodes all 11 original Morn layouts, selects the six actually used layouts and validates their skin/scroll references against the 76 symbols in the dedicated art. It retains 22 required ComponentFactory nodes from the original 109-node style entry, replacing only the selected style font with Microsoft YaHei. There is no missing active public-art dependency or copied full core. Five runtime files join the shared owner's 41-asset variant:

- `WorkshopNativeTreasureBootstrap.swf`
- `treasure-original-library.swf`
- `treasurehunting_v3_6_1_u1.swf`
- `treasurehunting_v3_6_1_u1.ui`
- `treasure-styles.xml`

```powershell
& '..\..\runtime\tools\node-v24.21.0-win-x64\node.exe' scripts/workshop-native-treasure.mjs NEW_RUNTIME_OUTPUT_DIRECTORY
& '..\..\runtime\tools\node-v24.21.0-win-x64\node.exe' scripts/native-treasure/audit-candidate.mjs NEW_RUNTIME_OUTPUT_DIRECTORY
```

`build-library.mjs` includes 17 actual business/layout owners from the original 31 owners. It replaces 63 complete method bodies with local dispatch and verifies all other method-code bytes unchanged. It preserves the original Timer, Glint, flight Tween and bag listeners; it exposes the minimum private fields needed for their local owner. Bag superclass initialization still precedes local bag setup. Old socket/payment/loading/rank consumption is disconnected, and excluded classes are not satisfied by empty stubs. The unused BagList mouse-over bitmap name uses the module's own `bagItemBg`; the original mouse-over callback does not use that allocation. Method code remains unchanged for this name adaptation.

## Local contract and original layout boundaries

The API owns `games.treasure`, shared with the old web activity. Public data is `nativeTreasure`; only a fresh matching envelope contains `nativeTreasureAction`. Role, generation, sequence, revision, the 54-character complete-state bag token and page-owned UUID are checked. Common callbacks are `workshopOpenTreasure`, `workshopStatusTreasure` and `workshopCloseTreasure`. Page callbacks are `workshopTreasureRead`, `workshopTreasureRequest` and `workshopTreasureReport`; the five Bootstrap callbacks use the existing `AcceptSnapshot`, `RejectRequest`, `OpenNative`, `CloseNative` and `StatusNative` suffixes.

Four ordinary local materials replace the original category interpretation: `11019`, `11001`, `11021`, `11002`. Only the first four material categories are enabled; remaining original category positions explicitly say “暂未提供”. Normal draws use the selected local pool and cost 30 activity points per draw; advanced draws require all four selected categories, cost 60 per draw and double material quantity. The existing local guarantee remains API-owned. Original coupons/stone points are not represented as valid payment. The visible continuous option means one atomic five-draw batch with one UUID; it never starts an unlimited request loop.

The API's fixed ten `drawChoices` cover normal/advanced counts 1–5. The original window exposes one draw or the five-draw checkbox. The original 30-cell bag keeps each API per-draw row independently. One cell click takes that row's entire quantity through permanent mail, preserving other rows. All-take and all-recycle remain available; recycling awards two local points per material unit. `11021` counts 1, 2 and 4 are valid; other local materials accept 1 or 2. Three explicit local progress rewards and fragment exchange use API fields rather than unknown private-server values.

Original RecordViewUI and its VBox occupy their original position and show real current-role history. Its visibility is synchronized after construction to avoid covering the default bag tab. The original full-server record implementation is excluded because it immediately makes old socket/catalog requests and uses unavailable host members. Original rank and paid subviews are excluded and their controls disabled. Raw original UI bytes remain unchanged; registered in-memory XML fonts, disabled nodes and local labels are documented in the candidate manifest/audit. Prize preview uses original list/cells with only the four real local templates.

## Animation and close behavior

Each fresh confirmed reward uses the original 300 ms × 10 highlight Timer, the original 56-frame Glint and the original BitmapData/TweenProxy/TimelineLite flight. The Glint sprite is id 80; its 706-byte timeline tag SHA-256 is `e2371db8f844e45fc7df155fc2af0352ab12805c3efcc215532cd13f70964eb7`.

The original frame script at slot 55 jumps back to frame 15. The native instance replaces that single slot with `stop()` on actual frame 56 so the preserved original `onEnterFrame` test can observe its final frame and start the actual flight. Original art, bitmap, timeline and stored frame-script bytes are unchanged. This is a disclosed instance compatibility change, not a synthetic timeout completion. The actual original Tween `twComplete`/`movieComplete` advances the confirmed reward queue, and only the final reward unlocks controls. The owned ENTER_FRAME wrapper and Timer completion reapply the whole-animation lock after original code re-enables checkboxes. GET and UUID replay render static state only.

Close stops both original timers, unbinds the movie wrapper and the original bag `movieComplete` listener, kills/clears outstanding timelines, removes completion callbacks, destroys TweenProxy and disposes temporary BitmapData. Every completion checks the current main-window owner. Closed pending requests remain in the page ledger; a late POST cannot reopen the window or start a new animation. No extra POST follows an animation, including five-draw batches.

## Verification boundary

`audit-candidate.mjs` checks 17 library ABCs, one original art ABC, complete art/UI hashes, active layout/style skin closure, 63 local dispatches, unchanged original method bodies, explicit preserved animation/bag/preview methods, host class presence and forbidden legacy calls. It also checks the five compiled callback registrations and required compiled close operations.

Compilation and offline verification do not establish AVM2/Ruffle acceptance, typography, whole-animation visual quality or actual mailbox delivery. Those remain client acceptance gates, alongside close/reopen, late responses, role drift and UUID replay. Candidates and failed tool-run evidence are preserved outside the repository; no live resources or player data are modified by these tools.

The final candidate is `runtime/reference-activities-completion-20261014/native-unified-treasure-candidate-20261015-c/`. Its manifest SHA-256 is `454922e71119db4db96b6c99aa9d817d6df3625e417fb99a2faabbb64e9fc35d`: 41 assets, 34 build-source pins, 21 common plus 30 Bootstrap callbacks, 17 Treasure ABCs, 63 dispatches, 149 unchanged bodies and 24 explicitly preserved methods. Six pinned host files have no shared-public-class intersections. Independent actual-ABC review found no additional blocking defect in the queue, frame override, close cleanup and initial tab fixes.

The controller's real-SWF isolated file test passed 6→18→36b→41c, repeated installation, no-flag rejection and complete rollback of three core files plus 41 owned resources; 14 live inputs remained unchanged. Its receipt is `runtime/reference-activities-completion-20261014/isolated-native-upgrade-d3efa74a-4478-4d2b-a17c-8b9d9c43871f/receipt.json`. The resulting isolated core SHA-256 is `840baa8638d588e1eb141dda1307c215ddf7cb3c3a1e85642f5bbd99ff370937`. This test does not run AVM2 or render the game. `source-freeze.json` records final source/asset/bridge/audit pins; no candidate is overwritten or deployed.

Failed joint a/b build-tool runs remain preserved. The b log records Node 24 V8 `Check failed: IsHeapObject()` in its native optimizing compiler. Joint c succeeds with build-command flags `--jitless --max-old-space-size=8192`; only Node's build-tool optimization changes, not the Java/Flex child compilation or game code. These tool failures are distinct from the passing final AS and structural checks.
