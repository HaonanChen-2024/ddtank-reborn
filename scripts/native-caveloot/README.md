# Original CaveLoot adapter (A17)

This is an offline compiled candidate for the original four-page mine, two mine-coin shops, eleven progress rewards, bag quantity/whole-bag settlement, help, and result windows. It is not installed or accepted in the real AVM2 client.

`buildNativeCaveLoot` and `auditCaveLoot` emit exactly four files under `/flash/workshop-native/caveloot/`:

- `WorkshopNativeCaveLootBootstrap.swf`
- `caveloot-original-library.swf`
- `caveloot.swf`
- `caveloot.ui`

The original 43 business/layout owners are isolated under `workshop.caveloot.original`; one bitmap glue ABC gives 44 library ABCs. The audit checks 94 explicit dispatch methods, 223 unchanged method bodies, and 43 named original methods. The three external bitmap skins are copied with their original JPEG3/Lossless2 payloads and exact sizes from the pinned cached `uicomponent_v3_6_1_u1.swf`: `asset.ui.scale.bg16` (84), `asest.ui.btn_check7` (57), and `asset.ui.btn_yellow7` (29). Local bitmap names prevent collisions. No extra public styles or prior activity first-open are required.

Raw art and raw UI bytes stay unchanged. All sixteen original layouts remain registered. Runtime layout changes isolate class names, use Microsoft YaHei, show local activity-point/mine-coin rules, hide the original unused automatic-mining checkbox, and remove five unsupported payment/rank Clip references. One malformed original result XML attribute has `y="U+0002"`; the adapter verifies and replaces only that byte with ASCII `0` in the inflated AMF buffer before XML decoding. This change does not alter the saved raw UI.

The six original MovieClips and their timelines are retained. The original `setInfo`, `__onMovieEnd`, and frame comparator determine completion at frame 70 or 76; an owned listener checks the current movie/window before invoking that original callback. There is no delay pretending to complete a movie. One fresh confirmed batch has at most five draws; aggregated server rewards are shown only after its selected original movie reaches the terminal frame. Busy stays set through the result popup. Closing a popup/window, an old automatic callback, and movie disposal never make another draw request. The original confirmation callback is cleared before disposal and called exactly once.

The page owns HTTP/UUID receipts. The module exposes five `workshopCaveLoot{AcceptSnapshot,RejectRequest,OpenNative,CloseNative,StatusNative}` callbacks and calls `workshopCaveLoot{Read,Request,Report}`. It requires the existing sole 82-ABC shared domain, real character ID, generation, sequence, revision and the full 54-character state token. First open only reads. GET/replay are static; a POST response cannot recreate a closed window. Close removes owned listeners, stops movies/timers, clears quantity/render handlers and owned cells, and keeps an unconfirmed UUID with the page ledger.

The frozen local contract is `native-caveloot-contract-b.ts` (SHA-256 `6d9d8ff02beed90b7025a10bd2280fe10becd183bbee246be2eef9dc3cceb962`). HTTP is `caveloot-native`, projection `nativeCaveLoot`, and fresh envelope `nativeCaveLootAction`. Existing `games.cave` remains the only state owner. The four material rows always exist, including zero counts; only positive rows enter the original bag list. Normal and advanced bags/currencies are separate. Historical records without a known type remain a separately labelled mixed bag and can only be settled as a whole. The server determines prices, limits, pity, mail rewards and eligibility; renderer changes never submit an action. Fresh draw results are unique template aggregates in catalog order, not one row per draw.

The local rules explicitly use ordinary materials and activity points: normal 15/advanced 35 points per draw, three daily free normal draws, a shared ten-draw pity and thirty-record capacity, separate mine coins from recycling, eight shop rows and eleven cumulative rewards. Original unknown equipment pool/Protect rules, real-money flows, global/server progress and global/cross-server ranking are unavailable. The original rank page states this and shows real current-character records. This does not reproduce the unknown original backend.

Run only from a fresh output directory:

```powershell
& 'D:\NODEJS\node.exe' --jitless --max-old-space-size=8192 scripts/workshop-native-caveloot.mjs '<fresh-output>'
& 'D:\NODEJS\node.exe' --jitless --max-old-space-size=8192 scripts/native-caveloot/audit-candidate.mjs '<fresh-output>'
```

Compilation, original-byte comparison and static ABI checks do not prove runtime acceptance. First-open constructors, font alignment/bounds, scrolling, all six actual animations, modal input, closing while pending, role changes, replay/reopen and the real mailbox cycle remain untested in the game client.
