# Original FirstRecharge window adapter (A13)

This module ports the original Main, three-tier reward/six-cell preview, Shop, fixed-quantity Buy and ShowAlert layouts. It implements explicit local task rewards, points purchases and permanent task-card issue/validate/use/claim/gift. It does not recreate reference payment semantics or the unavailable vipCoupons gift Frame.

## Inputs and isolation

- Original core: `2_v3_6_1_u9.png`, SHA `af361678887e2413efe54e6cd86d37426cc6724ea964080178eea4816a785ae4`.
- Original art: `firstrecharge_v3_6_1_u1.swf`, 211121 bytes, SHA `1c3b20c94859f1310d1da495f65a26928eb987774390fde57dd76f79e69dc1b5`.
- Original UI: `firstrecharge_v3_6_1_u1.ui`, 2324 bytes, SHA `95c1ee3d74dafe7b1f1c11cb0cd6c2c3d48b880a29429cc4a2d30997dd881eef`.
- Public shop catalog: thirteen original MstType2 rows, SHA `b17a44cd5e95ecaf5f5d89d7f4b997462ae88b0b994ba4486c22d03e43d73339`, evidence only. Private equipment, prices, random weights, expired dates and card bonus boxes are not local rules.

The 26-owner inventory contains 22 modern and four legacy owners. This library imports 21 modern owners; CouponsFrame needs missing vipCoupons resources and is explicitly excluded. The only actual public QName collision, `firstRecharge::FirstRechargeManager`, is renamed precisely to `firstRecharge::WorkshopFirstRechargeManager` across six ABCs, including the original script initializer's sole firstRecharge-scoped Multiname97 binding. The existing host owner and all unrelated namespaces remain unchanged.

Eight original bitmap tags from already saved uicomponent/coreii/uigeneral resources are embedded with minimal BitmapData glue. They use module-specific `workshop.firstrecharge.skin.Skin{id}` names, mapped in runtime XML, so first opening this module never requires opening Pair or another window. Original tags, UI and art bytes remain unchanged. Seven layouts are registered; the eighth unrelated Treasure template is excluded. Buy's original pre2/next2 arrows are included but disabled for fixed count1.

The original art has 38 bitmap symbols, no sprites and a one-frame root. No original reward animation is claimed.

## Local contract

- HTTP owner: `first-recharge-native`; projection `nativeFirstRecharge`; fresh envelope `nativeFirstRechargeAction`.
- Page callbacks: `workshopFirstRechargeRead/Request/Report`. Bootstrap registers `workshopFirstRechargeAcceptSnapshot/RejectRequest/OpenNative/CloseNative/StatusNative`.
- The shared loader owns the 82 common ABCs. The page owns real character identity, generation, sequence, monotonic revision, complete 54-character day-dot-SHA256 token and UUID ledger. Closing preserves uncertain committed requests; late POST replies do not reconstruct windows. GET/replay update static state only.
- Tier1 shares canonical `first-gift`. Tier2/3 require task-earned200/600. Exact reward previews come from the server as six slots; unused slots stay empty. Existing first-gift, points-gift and luxury claims are not duplicated.
- Four local material packages cost 15/20/25/30 activity points, each UTC-day limit10. Original MstType2 fixed quantity is retained: count1, disabled arrows/input, explicit total and owned confirmation. Permanent bound materials are mailed by the server transaction.
- Cards are explicitly local permanent task entitlements, not item12772. Issuing reserves the same canonical tier without fees or mail; using activates; claiming consumes once. Only the original issuer's unactivated owned card can be gifted once; received cards cannot be gifted again. No extra rewards or task-earned points are manufactured.
- Original ShowAlert is reused for local UUID validation and exact local recipient nickname. Additional Chinese controls identify issue/use/gift as local features. Missing original gift styling and unknown payment/card extras remain disclosed.

Manager dictionaries use real Dictionary objects, reward/shop rows use original sealed classes, and cardEndDate is Date-compatible null. Original RewardView's missing sealed ServerConfig getters and global unknown BossBox lookup are replaced by actual local projection values. There are no empty compatibility classes or live reference socket/payment paths.

## Offline build and audit

`workshop-native-first-recharge.mjs` exports `buildNativeFirstRecharge`; `audit-candidate.mjs` exports `auditFirstRecharge({projectRoot,outputDir,sharedPath})`. Both preserve prior candidates. The builder compiles only Bootstrap and minimal skin glue with pinned Flex/playerglobal, then extracts/adapts the selected original ABCs. Every unchanged method body and bitmap tag is compared against original bytes.

Four fixed runtime resources live under `/flash/workshop-native/first-recharge/`:

1. `WorkshopNativeFirstRechargeBootstrap.swf`
2. `first-recharge-original-library.swf`
3. `firstrecharge_v3_6_1_u1.swf`
4. `firstrecharge_v3_6_1_u1.ui`

The existing49 plus these4 gives a proposed53-resource joint variant; the root controller owns that joint link, bridge, installer and final freeze. This module does not modify existing shared/public source.

The final single-module candidate `native-first-recharge-candidate-20261015-c` compiled and audited with actual native exit0 on Node24.14.1 `--jitless`; Java/Flex Bootstrap and glue also exit0. Its library has21 original business owners plus one skin-glue ABC,28 adapted dispatch methods,106 untouched method bodies and26 specifically preserved original methods. Its audit reads actual Multiname namespace sets from raw ABC bytes; no old Manager binding remains.

Initial candidate a failed on the AS3 reserved local variable `use`. Candidate b compiled, but its early audit overlooked a script initializer's firstRecharge-scoped Multiname97 still binding the old Manager; its completion conclusion is withdrawn. Candidate c renames that single binding alongside the six exact QName references and strengthens the audit to reject it. Method bodies and bitmap tags remain unchanged. All failed or superseded logs/candidates remain as evidence; neither issue was an environment failure.

## Acceptance boundary

Offline compilation, exact ABC/bitmap checks and isolated package installation are separate from client acceptance. Actual AVM2/Morn opening, Chinese glyph/bounds alignment, three-tier preview, owned confirmation, card transfer, Close/reopen/replay/role drift and real permanent-mail collection remain pending. The original vipCoupons gift Frame and original payment-card bonus semantics are not implemented.