# Shared original activity candidate

Experimental, build only. `build-activities.mjs` emits one `workshop-native-activities` version 1 manifest for the existing installer; it does not deploy, start services, open the game, or touch player data.

The current builder adds variant `wardrobe-pair-mines-ddplay-gypsy`: 32 assets, 15 callback-only common entries and 5 Bootstrap callbacks each for Pair, Mines, DDPlay and Gypsy, with disjoint names. Mines retains 20 activity ABCs and six resources. DDPlay adds five business ABCs, the original Back easing class and a bitmap glue ABC in four resources. Gypsy adds eight business ABCs, one MovieClip glue ABC, the original art and 38 styles in four resources. Its original 40-frame preview glow retains all 85 shape/bitmap/sprite tags byte for byte. All five modules queue behind the same shared import. The earlier 18-, 24- and 28-asset candidates remain preserved; the builder and ABI descriptions below describe the current 32-asset variant. See `../native-mines/README.md`, `../native-ddplay/README.md` and `../native-gypsy/README.md`.

```powershell
& '..\..\runtime\tools\node-v24.21.0-win-x64\node.exe' scripts/native-shared/build-activities.mjs NEW_RUNTIME_OUTPUT_DIRECTORY
& '..\..\runtime\tools\node-v24.21.0-win-x64\node.exe' scripts/native-shared/audit-host.mjs WORKSHOP_ROOT NEW_RUNTIME_OUTPUT_DIRECTORY
```

The first candidate is `runtime/reference-activities-completion-20261014/native-unified-candidate-20261015`. Inputs retain the pinned previous 92-ABC original wardrobe library. `build-library.mjs` preserves every selected ABC and complete DoABC tag byte for byte: 82 shared ABCs (82 public classes plus two private helpers) and 10 wardrobe ABCs. The Pair component keeps its 26 original/adapted ABCs. The Pair component build's private shared-library copy is evidence only and is excluded from the current 32 packaged assets.

`WorkshopNativeWardrobeBridge.init()` remains the existing injected entry and registers callbacks only. The common owner binds the real `DisplayLoader.Context`, starts one shared Loader, and queues all five modules behind it. The bootstraps receive `sharedOwnerReady:true`, the same context/domain, role and generation; none imports a shared library. ApplicationDomain wrapper object identity is not used: actual class identities and the real LoaderContext slot are checked. All subsequent imports explicitly use the actual context's domain. Unknown pre-existing shared declarations, including a full unproven legacy load, require a fresh game session; only this owner's successful load can be reused. Error/timeout is terminal; imported classes are kept and never retried in another domain.

Public entry ABI:

- `workshopOpenWardrobe(characterId:Number):Boolean`, `workshopStatusWardrobe():Object`, `workshopCloseWardrobe():void` remain compatible.
- `workshopOpenPair(characterId:Number,generation:String):Boolean`, `workshopStatusPair():Object`, `workshopClosePair():void` are added.
- `workshopOpenMines(characterId:Number,generation:String):Boolean`, `workshopStatusMines():Object`, `workshopCloseMines():void` are added by the 24-asset variant.
- `workshopOpenDDPlay(characterId:Number,generation:String):Boolean`, `workshopStatusDDPlay():Object`, `workshopCloseDDPlay():void` are added by the 28-asset variant.
- `workshopOpenGypsy(characterId:Number,generation:String):Boolean`, `workshopStatusGypsy():Object`, `workshopCloseGypsy():void` are added by the 32-asset variant.
- Status reads current `Self.ID` even before an open; missing identity stays zero. Open requires the current real role in `main` and synchronously binds expected ID/generation before module/host callbacks.
- The page attaches the matching Pair, Mines, DDPlay or Gypsy host before open, keeps the same generation for this game instance, and owns action UUIDs. Each module has independent callbacks while all character activities share one pending ledger and flight. Closing cancels the requested window only, preserving generation and an in-flight request. A late response stays cached unless the user explicitly reopens. Explicit reopen during a pending GET reuses that GET; a pending POST stays locked and cannot trigger a late open.
- Bootstrap callback names retain each module's `AcceptSnapshot`, `RejectRequest`, `OpenNative`, `CloseNative` and `StatusNative` forms; none conflicts with the fifteen common-owner callbacks.

The combined builder checks compiled class/ABI inventories, fifteen callback-only init calls, the single shared Loader construction site, exact 32 resource paths, unchanged split ABCs, Pair's 99, Mines' 39, DDPlay's 31 and Gypsy's 36 adapted methods, and absence of legacy payment/network calls. Gypsy's extra glue contains only the original constructor-only MovieClip declaration, and all 85 glow tags retain their exact payload/timeline bytes. `audit-host.mjs` checks the targeted current host files and writes their hashes and declaration intersections. The wardrobe component manifest is deliberately `workshop-native-wardrobe-component` with `requiresUnifiedManifest:true`; it must not be installed alone without the shared owner/resources.

Not deployed or accepted as runtime complete: pair-first, wardrobe-first, mines-first, DDPlay-first, Gypsy-first, concurrent first open, close/reopen while loading/GET/POST, role change, terminal error, original animations/visual alignment, and API/mail whole-cycle tests still require the real client. The production wardrobe paging Ruffle panic is unresolved. Compilation and static verification do not prove it fixed. Preserve the previous failed/candidate directories for that diagnosis.
