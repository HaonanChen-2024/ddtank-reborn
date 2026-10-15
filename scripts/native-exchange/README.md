# Original ExchangeAct local candidate

This module retains the original `ExchangeActView`, `ExchangeGoodsView`, `ExchangeGoodsCell`, two real event classes and four typed data owners. It imports nine original business ABCs and adapts eleven method bodies (including two constructors); the other 57 bodies remain byte-identical. The selected original window keeps four recipe buttons, the quantity input, eight input slots and six output slots. It does not load the full Wonderful/Calendar managers or overwrite the existing host `IRightView`.

The four payloads are fixed under `/flash/workshop-native/exchange/`:

- `WorkshopNativeExchangeBootstrap.swf`
- `exchange-original-library.swf`
- `exchange-original-art.swf`
- `exchange-styles.xml`

The art contains 54 original bitmap definitions from three existing, pinned SWFs. Only their local character IDs and symbols change; pixel/alpha payloads remain exact. There are no sprites or original reward animations in this closure. All 56 selected style definitions are checked against the pinned original styles archive before generating isolated style names, bitmap aliases and Microsoft YaHei formats. Raw reference files remain unchanged. `asset.core.btmBimap` is the original `ScaleBitmapImage` style, backed by the original `asset.core.btmBG` bitmap; original light/gray filters are included.

Build in a fresh directory with the existing Java/Flex/playerglobal tools:

```powershell
& D:\NODEJS\node.exe --jitless --max-old-space-size=8192 scripts/workshop-native-exchange.mjs <new-output-directory>
& D:\NODEJS\node.exe --jitless --max-old-space-size=8192 scripts/native-exchange/audit-candidate.mjs <output-directory>
```

`buildNativeExchange` and `auditExchange({projectRoot, outputDir, sharedPath})` support the verified shared packaging workflow. The bootstrap uses the existing sole 82-ABC shared owner and registers five module callbacks. Common bridge and installer changes belong to the integrator.

The public contract is `exchange-native` / `nativeExchange` / fresh-only `nativeExchangeAction`, frozen contract B. The page owns authentication, generation, sequence and UUIDs. Each explicit exchange button press submits only `{type:'exchange', index, count, choice}`; category, recipe and quantity changes never POST. There is no extra confirmation in the original flow. A fresh effect must match the requested recipe totals and UUID, with `committedRevision` a positive integer no newer than its containing snapshot. GET/replay performs only static synchronization.

The local category has four declared recipes: 11019×4→11021×1, 11001×4→11002×1, 11021×2→11019×3 and 11002×2→11001×3. Each has ten units per UTC day, with batches of one to ten constrained by the authoritative material count and remaining quota. It consumes no activity points. The game owns PropBag1 eligibility, locked/session/lobby checks, queue/cache/persistence and the atomic bag/receipt/mail transaction. The client never reads raw bag counts or submits item IDs, slots, templates or prices. Output is bound and permanent, sent by mail.

Offline projections retain four recipes with unknown material counts displayed as `?`; unavailable service projections retain the original empty grids and reason with paired empty material/recipe arrays. Both disable exchange and have no action token. A currently online but locked/ineligible actor may display true counts while still disabling exchange. Refresh clears the old recipe dictionary so a formerly available catalog cannot leak into an unavailable view.

Closing disposes the original goods child, grids, count input and listeners, and always removes the owned root. Unconfirmed UUID state remains for the page ledger; late action replies update data without rebuilding a closed window. No game/browser/service/database is started by these build scripts.

The reference's 14 categories, 36 recipes and 42 unknown outputs are not claimed as ported. This is a local four-recipe slice. Compilation, structural audits and isolated installer checks do not establish AVM2, first-open, font placement, real bag-to-mail or interaction acceptance. Those gates remain pending until actually exercised.
