# 第一步：源码固化结果

仅本地提交；未推送任何远程。23个二进制采用现有Git LFS，80个内容相同的文件只刷新索引。未改变 overlay 权威规则。

- 服务端功能与界面：`53fc4fbaa37142455490e2570dfe9f3a0bae4bf4`，81文件。
- 战斗引擎：`56341bf47c11481e2f01adb9a7d009d3a0b4d802`，32文件。
- 翻译数据：`eb18b1132cdf0ad47c37356ae946897f67f3bd30`，26文件。
- 客户端资源：`8e26d0e542e20e9622989f0993fea4b69f26d78b`，23文件。
- 脚本与测试：`322bc287253a491fecc3d2dd8dfc59df843a6bf4`，53文件。

## 分支收录结论

- `codex/caveloot-normal-play`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/chinese-game-logo`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/christmas-library-order`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/core-playability-zh`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/devil-normal-play`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/devil-shop-host`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/feedback-display-text`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/game-energy-label`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/hall-night-hover`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/mines-playable-layout`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/moonlight-normal-play`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/moonlight-shop-host`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/playtest-purchases-props-tooltip`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/smith-battle-music`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/treasure-cardbox-use`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/treasure-jewelry-use`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/treasure-necklace-use`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/treasure-petfood-admission`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。
- `codex/treasure-petfood-use`：已并入（内容收录），以当前工作区的后续修复为准；逐文件差异见下文。

当前全量测试基线：1170通过、21失败、20跳过；修复验证在步骤4完成。8处漂移仅第17行行尾空格清理，实际语句未变。已有14个Draft PR保持原状，后续发布待用户决定。

# 本地 codex 分支与冻结工作区覆盖台账

冻结基线：`1585d30c1ea3ff0134b72724fd0c9770fb8342dd`（`codex/local-workshop`）。共 20 个本地 codex 分支，其中其它分支 19 个，比任务初始口径多1个；本表含 `codex/game-energy-label`。

逐文件比较 187 个路径、928 个分支/文件组合。766 个组合已按字节、CRLF/BOM归一或LFS内容哈希确认相同；162 个组合存在后续文本差异（31 个不同路径、38 个旧版本）。工作区缺失文件0，未解决二进制差异0。

读入期间漂移0；最终复核漂移：8。没有 Git 写入、checkout、merge、源码/overlay更改、服务/数据库/浏览器操作。

## 判断方法

- 每分支使用与冻结 HEAD 的 merge-base；共同基点之后的提交逐项列在 JSON，含每提交改动文件。被其它分支继承的提交单独标识，不能误叫该分支独占。
- 文本内容比较只容忍 CRLF 与 UTF-8 BOM；不把代码/语义差异当格式差异。
- 7类资源（两张邮箱图及room/roomlist/store/ddtstore/storefinebringup）是 Git LFS 指针；指针 oid+size 与工作区实体完全一致。
- 对不同文本做38组只读 `git apply --check --reverse --ignore-whitespace --unidiff-zero`，19组通过。失败不等于缺失，随后按逐键/后续owner差异说明。
- 未跟踪文件直接读实际文件；不能因为 `git diff 分支`将其显示为删除就判断丢失。
- 主控已将本表对应工作区固化至下列5个主题提交。下表“已并入”指内容已收录或由所列后续修复覆盖，不表示 Git merge 祖先关系，也不表示游戏验收通过。

## 分支总览

| 分支 | 头SHA | 基点 | 提交/净文件 | 内容一致 | 不一致 | 建议 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| codex/caveloot-normal-play | 9d118044d79b | 10a9165d5a14 | 3/8 | 4 | 4 | 保留工作区 |
| codex/chinese-game-logo | c27e0bea3b8d | 10a9165d5a14 | 17/109 | 89 | 20 | 保留工作区 |
| codex/christmas-library-order | 10ae0b756812 | 10a9165d5a14 | 1/4 | 4 | 0 | 保留工作区 |
| codex/core-playability-zh | d073d9264501 | 10a9165d5a14 | 16/109 | 88 | 21 | 保留工作区 |
| codex/devil-normal-play | cc202c60c98e | 10a9165d5a14 | 4/9 | 9 | 0 | 保留工作区 |
| codex/devil-shop-host | 67b96721f5c0 | 10a9165d5a14 | 2/5 | 4 | 1 | 保留工作区 |
| codex/feedback-display-text | 91fe08f32f4e | 10a9165d5a14 | 21/127 | 116 | 11 | 保留工作区 |
| codex/game-energy-label | 0ed1dd790661 | 10a9165d5a14 | 19/129 | 106 | 23 | 保留工作区 |
| codex/hall-night-hover | c4a7793f9c3f | 10a9165d5a14 | 17/113 | 92 | 21 | 保留工作区 |
| codex/local-workshop | 1585d30c1ea3 | 1585d30c1ea3 | 0/0 | 0 | 0 | 保留工作区 |
| codex/mines-playable-layout | d1dd8ea849ac | 10a9165d5a14 | 3/5 | 2 | 3 | 保留工作区 |
| codex/moonlight-normal-play | 3a9aea8b0b54 | 10a9165d5a14 | 2/5 | 5 | 0 | 保留工作区 |
| codex/moonlight-shop-host | a71eb2ad9025 | 10a9165d5a14 | 1/3 | 0 | 3 | 保留工作区 |
| codex/playtest-purchases-props-tooltip | 7fea253ebce5 | 10a9165d5a14 | 18/128 | 105 | 23 | 保留工作区 |
| codex/smith-battle-music | 1d091e545264 | 10a9165d5a14 | 17/117 | 95 | 22 | 保留工作区 |
| codex/treasure-cardbox-use | 0956734734f1 | 1585d30c1ea3 | 2/9 | 7 | 2 | 保留工作区 |
| codex/treasure-jewelry-use | 08fcf3f89ea0 | 1585d30c1ea3 | 3/12 | 10 | 2 | 保留工作区 |
| codex/treasure-necklace-use | 0acaf985984b | 1585d30c1ea3 | 1/5 | 3 | 2 | 保留工作区 |
| codex/treasure-petfood-admission | 3dee8ed492cd | 1585d30c1ea3 | 5/16 | 15 | 1 | 保留工作区 |
| codex/treasure-petfood-use | 0264422ca4cd | 1585d30c1ea3 | 4/15 | 12 | 3 | 保留工作区 |

## 不一致文件的具体差异及取舍

| ID | 文件 | 分支 | 差异与依据 | 建议 |
| --- | --- | --- | --- | --- |
| D01 | `apps/game/src/handlers/rooms.ts` | codex/caveloot-normal-play, codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/mines-playable-layout, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区新增 PROP_BUY/PROP_SELL 54/55 路由及 room-props 引入；分支原房间反馈修改仍可反向核验。 依据：apps/game/src/handlers/room-props.ts; apps/game/test/room-props-feedback.test.ts | 工作区；branch_patch_present_with_additional_workspace_changes |
| D02 | `apps/web/src/pages/Play.tsx` | codex/caveloot-normal-play, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/mines-playable-layout, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区将 DDReborn 图标/失败回退改为纯中文“弹弹堂”；活动入口改动仍保留。 依据：codex/chinese-game-logo c27e0bea3b8d0f3ea156c48191ef175b89df07ec | 工作区；branch_patch_present_with_additional_workspace_changes |
| D03 | `research/i18n/zh-CN-server-overrides.json` | codex/caveloot-normal-play, codex/mines-playable-layout | 工作区补足完整服务端中文词典并把 VIP 显示改为贵宾；相较较新分支只新增家园成功及操作成功两个已断行修复的键。 依据：research/i18n/zh-CN-dictionary-format-repairs.json; scripts/workshop-language.test.mjs | 工作区；superseded_by_exact_other_branch_result |
| D04 | `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as` | codex/caveloot-normal-play | 工作区把底部提示移至 y=572、高24，简化常驻提示并将完整规则移入帮助窗；窗口构造和奖励流程修复可反向核验。 依据：scripts/native-caveloot/README.md; 工作区 constructWindow/renderStatic/CaveLootHelpView 差异 | 工作区；branch_patch_present_with_additional_workspace_changes |
| D05 | `apps/api/src/templates/defs.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区新增 Achievement_Goods 三列主键和 translateRows 出站翻译；保留原模板覆盖。 依据：apps/api/test/feedback-display-text.test.ts | 工作区；branch_patch_present_with_additional_workspace_changes |
| D06 | `apps/game/src/db/templates.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区增加黄金武器模板映射及 Card_Group/Card_Buff 套卡加载、筛选套卡5/9；分支已有翻译改动仍可反向核验。 依据：apps/game/src/db/templates.ts findGoldTemplate/loadPetsCards; frozen HEAD 的卡牌效果 owner | 工作区；branch_patch_present_with_additional_workspace_changes |
| D07 | `apps/game/src/game/events.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区新增成就称号显示映射，持久化 RewardPara 身份保持原值，只翻译出站显示。 依据：apps/game/test/achievement-title-display.test.ts; codex/feedback-display-text | 工作区；superseded_by_exact_other_branch_result |
| D08 | `apps/game/src/handlers/events.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区在称号列表包及获得称号提示中使用 achievementTitleName；不能以旧版整个文件覆盖补充翻译。 依据：apps/game/test/achievement-title-display.test.ts; codex/feedback-display-text | 工作区；superseded_by_exact_other_branch_result |
| D09 | `apps/game/src/handlers/forge.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区强化、合成等路径有持久化锁/commitPlayerMutation、材料及模板验证，并保留中文失败反馈；分支旧强化实现不能整文件回盖。邮件标题改为“铁匠铺退还道具”，原中文fallback说明的旧注释又出现葡文，属注释差异。 依据：apps/game/test/treasure-strengthen.test.ts; apps/game/src/game/player-transaction.ts; frozen HEAD 后续宝物owner | 工作区；overlapping_later_changes_review_before_marking_integrated |
| D10 | `apps/game/src/handlers/pets.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 相较旧汉化分支，工作区增加宠物喂养及卡盒事务保存；相较 petfood 分支，差异为宠物捕获/装备/升星中文及 lang.t 调用，喂养持久化改动仍保留。 依据：apps/game/test/treasure-petfood-use.test.ts; apps/game/test/treasure-cardbox-use.test.ts | 工作区；branch_patch_present_with_additional_workspace_changes |
| D11 | `apps/game/src/handlers/use.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区开箱和修炼使用持久化锁及原子提交；快捷购买、贵宾续费增加参数验证和中文失败日志。分支旧开箱/修炼实现与后续owner重叠，不能整文件回退。 依据：apps/game/test/shop-shortcuts.test.ts; apps/game/test/treasure-necklace-use.test.ts; apps/game/src/game/player-transaction.ts | 工作区；overlapping_later_changes_review_before_marking_integrated |
| D12 | `apps/game/src/server.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区给战斗依赖追加 cardSets: templates.cardSets；原分支改动可反向核验。 依据：packages/fight/src/game/equipEffects.ts; frozen HEAD1585d30卡牌效果提交 | 工作区；branch_patch_present_with_additional_workspace_changes |
| D13 | `apps/game/src/session/login.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区 loadUserItems 传入 findGoldTemplate，支持重登黄金装备外观；分支已有首充可用性/中文改动可反向核验。 依据：apps/game/src/db/templates.ts findGoldTemplate | 工作区；branch_patch_present_with_additional_workspace_changes |
| D14 | `docs/workshop.zh-CN.md` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区末尾追加静态卡牌、称号/道具附文及词典断行反馈说明；原分支正文保持。文档中运行状态仍是历史日期记录，后续文档瘦身需按新证据更新。 依据：追加小节“试玩反馈中的补充显示文字” | 工作区；branch_patch_present_with_additional_workspace_changes |
| D15 | `packages/db/src/translations.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区允许已核对的 Shop_Goods.Data 固定ID及 Achievement_Goods.RewardPara，加入补充文件合并；保留机器Data禁止翻译的约束。 依据：packages/db/src/template-display-data.ts; apps/api/test/feedback-display-text.test.ts | 工作区；superseded_by_exact_other_branch_result |
| D16 | `packages/db/test/template-text.test.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区仅为 parts/entries 测试数组补 Record<string,string> 类型注解，断言和测试数据未改。 依据：两个显式类型注解差异，未在本审查运行测试 | 工作区；superseded_by_exact_other_branch_result |
| D17 | `packages/fight/src/game/equipEffects.ts` | codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区 MakeCriticalEffect 改用 takePlayerDamage、按攻击者 lucky 计算，并在 afterPlayerShooted 清理 flyingPartical；分支中文过程提示修改仍可反向核验。 依据：MakeCriticalEffect.cs:56 已在当前代码注释标注；frozen HEAD1585d30 | 工作区；branch_patch_present_with_additional_workspace_changes |
| D18 | `research/i18n/zh-CN-overrides.json` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区拆开被粘入 HoleLabel 的 store.view.transfer.EmptyItem，恢复独立提示键，其余键保持。 依据：research/i18n/zh-CN-dictionary-format-repairs.json | 工作区；superseded_by_exact_other_branch_result |
| D19 | `research/i18n/zh-CN-server-overrides.json` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区补足完整服务端中文词典并把 VIP 显示改为贵宾；相较较新分支只新增家园成功及操作成功两个已断行修复的键。 依据：research/i18n/zh-CN-dictionary-format-repairs.json; scripts/workshop-language.test.mjs | 工作区；branch_records_preserved_with_additions |
| D20 | `research/i18n/zh-CN-template-text.json` | codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/hall-night-hover, codex/smith-battle-music | 按 table:rowId 逐记录比较，分支15350条全部原样保留；工作区只新增 Shop_Goods:9107258 泡泡茶说明，数组插入不能视为大量原翻译丢失。 依据：逐记录语义比较：missing=0、changed=0、added=1 | 工作区；branch_patch_present_with_additional_workspace_changes |
| D21 | `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as` | codex/chinese-game-logo, codex/core-playability-zh, codex/feedback-display-text, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区把底部提示移至 y=572、高24，简化常驻提示并将完整规则移入帮助窗；窗口构造和奖励流程修复可反向核验。 依据：scripts/native-caveloot/README.md; 工作区 constructWindow/renderStatic/CaveLootHelpView 差异 | 工作区；branch_patch_present_with_additional_workspace_changes |
| D22 | `scripts/workshop-language.mjs` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区增加三处源哈希绑定断行修复，只修改部署副本行界限；分支原生成/保护逻辑可反向核验。 依据：research/i18n/zh-CN-dictionary-format-repairs.json; scripts/workshop-language.test.mjs | 工作区；branch_patch_present_with_additional_workspace_changes |
| D23 | `scripts/workshop-language.test.mjs` | codex/chinese-game-logo, codex/core-playability-zh, codex/game-energy-label, codex/hall-night-hover, codex/playtest-purchases-props-tooltip, codex/smith-battle-music | 工作区增加断行修复和拒绝源漂移测试，既有中文覆盖断言改用修复后的源；有效服务端键数3568变3570，对应两个恢复键。 依据：新增 reported client/home 与 format repairs 测试；本审查未执行 | 工作区；superseded_by_exact_other_branch_result |
| D24 | `scripts/native-devil/WorkshopNativeDevilBootstrap.as` | codex/devil-shop-host | 工作区 setPos 先将 workshop.devil.original. 归一为 devilTurn.；原shop构造身份补丁保留，并与 devil-normal-play 后续修复一致。 依据：codex/devil-normal-play c7296cc/cc202c6 系列 | 工作区；branch_patch_present_with_additional_workspace_changes |
| D25 | `apps/game/HANDLERS.md` | codex/game-energy-label, codex/playtest-purchases-props-tooltip | 工作区追加54/55房间道具实现记录，并补快捷购买/贵宾续费的中文错误和价格校验说明；待办表不再把这些已实现路由列未完成。 依据：apps/game/src/handlers/room-props.ts; apps/game/src/handlers/use.ts | 工作区；overlapping_later_changes_review_before_marking_integrated |
| D26 | `apps/game/src/handlers/items.ts` | codex/game-energy-label, codex/playtest-purchases-props-tooltip | 工作区 loadEquippedItems 追加 findGoldTemplate，保持读取他人装备时黄金外观映射；其它分支改动可反向核验。 依据：apps/game/src/db/templates.ts findGoldTemplate | 工作区；branch_patch_present_with_additional_workspace_changes |
| D27 | `packages/fight/src/game/game.ts` | codex/game-energy-label, codex/playtest-purchases-props-tooltip | 工作区范围伤害路径追加 owner.hooks.emit(takePlayerDamage)，匹配当前 MakeCriticalEffect 的事件owner。 依据：packages/fight/src/game/equipEffects.ts; frozen HEAD1585d30 | 工作区；branch_patch_present_with_additional_workspace_changes |
| D28 | `scripts/native-moonlight/WorkshopNativeMoonlightBootstrap.as` | codex/moonlight-shop-host | 工作区移除 localShopRows 的 info:null，避免 Morn 绑定行数据早于渲染时触发原版 info setter 空引用；原构造身份补丁保留。 依据：codex/moonlight-normal-play 3a9aea8b0b54392419705c4245c5b69c25ec0f65 | 工作区；branch_patch_present_with_additional_workspace_changes |
| D29 | `scripts/native-moonlight/audit-candidate.mjs` | codex/moonlight-shop-host | 工作区增加实际 Morn dataSource 先绑定的模拟与断言，并验证localShopRows构造字段8→7、不得提前传info:null；同义后续测试增强。 依据：codex/moonlight-normal-play 3a9aea8b0b54392419705c4245c5b69c25ec0f65 | 工作区；branch_patch_present_with_additional_workspace_changes |
| D30 | `scripts/native-moonlight/shop-item-host.test.mjs` | codex/moonlight-shop-host | 当前文件真实存在（即使相对当前HEAD尚未跟踪，git diff旧分支可能误显删除）；新增Morn绑定顺序/null info实测字节码检查，允许localShopRows与渲染方法的预期差异，其余方法/资源保持。 依据：codex/moonlight-normal-play 3a9aea8b0b54392419705c4245c5b69c25ec0f65 | 工作区；superseded_by_exact_other_branch_result |
| D31 | `scripts/workshop-literals.mjs` | codex/smith-battle-music | 工作区在武器音频/战斗音乐补丁外继续增加 --smith-gift-price 选项、部署journal标志与价格补丁链；原音乐分支能力仍被保留在组合器中。 依据：tools/i18n/abc-strings/smith-gift-price.mjs; scripts/workshop-smith-gift-price.test.mjs | 工作区；superseded_by_exact_other_branch_result |
| D32 | `apps/api/src/activities/treasure-catalog.ts` | codex/treasure-cardbox-use | 工作区目录策略发展到 verified-use-routes-v10-petfood68，保留项链v7/卡盒v8/首饰v9旧版本身份，并追加卡盒依赖、8514/9523首饰和334103高档粮准入。旧分支不能整文件覆盖现目录。 依据：codex/treasure-petfood-admission; isKnownTreasurePoolVersion; 对应fixtures和integration测试 | 工作区；superseded_by_exact_other_branch_result |
| D33 | `apps/api/test/treasure-native.test.ts` | codex/treasure-cardbox-use | 工作区保留项链/卡盒/首饰测试并增加高档粮；readyRows随依赖准入41→50→52→53，兼容旧奖池版本断言继续保留。数字差异来自后续明确目录扩展。 依据：apps/api/src/activities/treasure-catalog.ts; treasure-cardbox/jewelry/necklace/petfood测试 | 工作区；superseded_by_exact_other_branch_result |
| D34 | `apps/api/src/activities/treasure-catalog.ts` | codex/treasure-jewelry-use, codex/treasure-petfood-use | 工作区目录策略发展到 verified-use-routes-v10-petfood68，保留项链v7/卡盒v8/首饰v9旧版本身份，并追加卡盒依赖、8514/9523首饰和334103高档粮准入。旧分支不能整文件覆盖现目录。 依据：codex/treasure-petfood-admission; isKnownTreasurePoolVersion; 对应fixtures和integration测试 | 工作区；superseded_by_exact_other_branch_result |
| D35 | `apps/api/test/treasure-native.test.ts` | codex/treasure-jewelry-use, codex/treasure-petfood-use | 工作区保留项链/卡盒/首饰测试并增加高档粮；readyRows随依赖准入41→50→52→53，兼容旧奖池版本断言继续保留。数字差异来自后续明确目录扩展。 依据：apps/api/src/activities/treasure-catalog.ts; treasure-cardbox/jewelry/necklace/petfood测试 | 工作区；superseded_by_exact_other_branch_result |
| D36 | `apps/api/src/activities/treasure-catalog.ts` | codex/treasure-necklace-use | 工作区目录策略发展到 verified-use-routes-v10-petfood68，保留项链v7/卡盒v8/首饰v9旧版本身份，并追加卡盒依赖、8514/9523首饰和334103高档粮准入。旧分支不能整文件覆盖现目录。 依据：codex/treasure-petfood-admission; isKnownTreasurePoolVersion; 对应fixtures和integration测试 | 工作区；superseded_by_exact_other_branch_result |
| D37 | `apps/api/test/treasure-native.test.ts` | codex/treasure-necklace-use | 工作区保留项链/卡盒/首饰测试并增加高档粮；readyRows随依赖准入41→50→52→53，兼容旧奖池版本断言继续保留。数字差异来自后续明确目录扩展。 依据：apps/api/src/activities/treasure-catalog.ts; treasure-cardbox/jewelry/necklace/petfood测试 | 工作区；superseded_by_exact_other_branch_result |
| D38 | `apps/game/src/handlers/pets.ts` | codex/treasure-petfood-admission, codex/treasure-petfood-use | 相较旧汉化分支，工作区增加宠物喂养及卡盒事务保存；相较 petfood 分支，差异为宠物捕获/装备/升星中文及 lang.t 调用，喂养持久化改动仍保留。 依据：apps/game/test/treasure-petfood-use.test.ts; apps/game/test/treasure-cardbox-use.test.ts | 工作区；branch_patch_present_with_additional_workspace_changes |

## 各分支逐文件覆盖记录

### codex/caveloot-normal-play

头 `9d118044d79bc891e30fccaf12630bdc972e2fd8`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `edabd1a81a47` fix(workshop): expose activity tasks and translate room feedback；改动4文件；其它分支也包含此提交。
- `cb9f57e2643d` Translate core login and battle feedback into Chinese；改动1文件；其它分支也包含此提交。
- `9d118044d79b` fix(caveloot): restore native window and normal reward flow；改动4文件；本地列举分支中独占提交。

内容已覆盖文件：

- `apps/web/src/pages/Play.native-menu.test.tsx`
- `scripts/native-caveloot/README.md`
- `scripts/native-caveloot/build-library.mjs`
- `scripts/native-caveloot/shop-item-host.test.mjs`

内容不一致文件（详细摘要见上表）：

- `apps/game/src/handlers/rooms.ts`：D01；branch_patch_present_with_additional_workspace_changes。
- `apps/web/src/pages/Play.tsx`：D02；branch_patch_present_with_additional_workspace_changes。
- `research/i18n/zh-CN-server-overrides.json`：D03；superseded_by_exact_other_branch_result。
- `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as`：D04；branch_patch_present_with_additional_workspace_changes。

### codex/chinese-game-logo

头 `c27e0bea3b8d0f3ea156c48191ef175b89df07ec`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `edabd1a81a47` fix(workshop): expose activity tasks and translate room feedback；改动4文件；其它分支也包含此提交。
- `cb9f57e2643d` Translate core login and battle feedback into Chinese；改动1文件；其它分支也包含此提交。
- `1d431f768290` Localize runtime battle effect and insufficient-money messages；改动4文件；其它分支也包含此提交。
- `40aa5ac255be` fix(i18n): clarify cave materials and footer rules；改动3文件；其它分支也包含此提交。
- `c7628498c0d5` fix(i18n): translate the native flight prop tooltip；改动2文件；其它分支也包含此提交。
- `7755f786cfc0` fix(i18n): translate the native extra attack tooltip；改动2文件；其它分支也包含此提交。
- `ec6c76c4722d` fix(i18n): complete native battle toolbar prop text；改动2文件；其它分支也包含此提交。
- `f56f10dd7f33` fix(i18n): translate activity potion names and experience feedback；改动3文件；其它分支也包含此提交。
- `cf533e622fc9` fix(i18n): translate common activity material descriptions；改动2文件；其它分支也包含此提交。
- `8746f0c64956` fix(i18n): translate cumulative sign reward materials；改动2文件；其它分支也包含此提交。
- `458e5b1d4a12` fix(i18n): translate mail and item-use feedback；改动1文件；其它分支也包含此提交。
- `77aa846ff6e6` fix(i18n): translate pet feeding feedback；改动1文件；其它分支也包含此提交。
- `6145758a85b8` fix(i18n): translate original email window captions；改动5文件；其它分支也包含此提交。
- `a5f0c08501d6` fix(i18n): localize claim feedback and verify battle reward persistence；改动5文件；其它分支也包含此提交。
- `fff12cebde49` fix(events): reject unconfigured first recharge gifts before claiming；改动7文件；其它分支也包含此提交。
- `d073d9264501` fix(i18n): translate displayed game content and interface into Chinese；改动92文件；其它分支也包含此提交。
- `c27e0bea3b8d` Use Chinese branding on the game page；改动1文件；本地列举分支中独占提交。

内容已覆盖文件：

- `apps/admin/src/crud/FieldInput.tsx`
- `apps/admin/src/crud/schema.ts`
- `apps/admin/src/mocks/db.ts`
- `apps/admin/src/mocks/handlers.ts`
- `apps/admin/src/pages/Dashboard.tsx`
- `apps/admin/src/pages/Events.tsx`
- `apps/admin/src/pages/Mail.tsx`
- `apps/admin/src/pages/ServerConfig.tsx`
- `apps/admin/src/resources/content.ts`
- `apps/admin/src/resources/event-systems.ts`
- `apps/admin/src/resources/guilds.ts`
- `apps/admin/src/resources/items.ts`
- `apps/admin/src/resources/players.ts`
- `apps/admin/src/resources/system.tsx`
- `apps/admin/test/api-chinese-errors.test.ts`
- `apps/admin/test/i18n.test.ts`
- `apps/api/src/routes/admin-resources.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/test/chinese-display-overlay.test.ts`
- `apps/api/test/item-name-overlay.test.ts`
- `apps/api/test/template-text-overlay.test.ts`
- `apps/game/src/db/consortia.ts`
- `apps/game/src/game/cards.ts`
- `apps/game/src/game/consortia-mgr.ts`
- `apps/game/src/game/consortia.ts`
- `apps/game/src/game/world-boss-rewards.ts`
- `apps/game/src/handlers/academy.ts`
- `apps/game/src/handlers/activities.ts`
- `apps/game/src/handlers/auction.ts`
- `apps/game/src/handlers/basic.ts`
- `apps/game/src/handlers/consortia.ts`
- `apps/game/src/handlers/farm.ts`
- `apps/game/src/handlers/hotspring.ts`
- `apps/game/src/handlers/mail.ts`
- `apps/game/src/handlers/marriage.ts`
- `apps/game/test/events-feedback.test.ts`
- `apps/game/test/fight.test.ts`
- `apps/game/test/first-recharge-config.test.ts`
- `apps/game/test/first-recharge-login.test.ts`
- `apps/web/index.html`
- `apps/web/src/components/GameFrame.tsx`
- `apps/web/src/components/SiteLayout.tsx`
- `apps/web/src/mocks/handlers.ts`
- `apps/web/src/pages/Play.native-menu.test.tsx`
- `apps/web/src/pages/Play.tsx`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GAH1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GK1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GT1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KD1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KT1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAEpic13402.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAH13202.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAN13102.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAS13002.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAT13302.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhHardLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhNormalLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhSimpleLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirdNormalBloomNpcS2.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorBrynBoss.ts`
- `packages/fight/test/equip-language.test.ts`
- `packages/ui/src/api.ts`
- `packages/ui/src/components/dialog.tsx`
- `packages/ui/src/components/misc.tsx`
- `packages/ui/src/i18n.tsx`
- `research/i18n/bag-art/email.zh-CN.json`
- `research/i18n/bag-art/email/5.png`
- `research/i18n/bag-art/email/54.png`
- `research/i18n/zh-CN-item-names.json`
- `research/i18n/zh-CN-pve-overrides.json`
- `research/i18n/zh-CN-server-additions.json`
- `research/i18n/zh-CN-server-row-overrides.json`
- `scripts/workshop-bag-art.mjs`
- `scripts/workshop-client-chinese-coverage.test.mjs`
- `scripts/workshop-email-art.test.mjs`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/templates/defs.ts`：D05；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/db/templates.ts`：D06；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/game/events.ts`：D07；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/events.ts`：D08；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/forge.ts`：D09；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/handlers/pets.ts`：D10；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/rooms.ts`：D01；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/use.ts`：D11；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/server.ts`：D12；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/session/login.ts`：D13；branch_patch_present_with_additional_workspace_changes。
- `docs/workshop.zh-CN.md`：D14；branch_patch_present_with_additional_workspace_changes。
- `packages/db/src/translations.ts`：D15；superseded_by_exact_other_branch_result。
- `packages/db/test/template-text.test.ts`：D16；superseded_by_exact_other_branch_result。
- `packages/fight/src/game/equipEffects.ts`：D17；branch_patch_present_with_additional_workspace_changes。
- `research/i18n/zh-CN-overrides.json`：D18；superseded_by_exact_other_branch_result。
- `research/i18n/zh-CN-server-overrides.json`：D19；branch_records_preserved_with_additions。
- `research/i18n/zh-CN-template-text.json`：D20；branch_patch_present_with_additional_workspace_changes。
- `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as`：D21；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.mjs`：D22；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.test.mjs`：D23；superseded_by_exact_other_branch_result。

### codex/christmas-library-order

头 `10ae0b7568120fe80dc24f278f4a79858fbefe18`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `10ae0b756812` fix(christmas): load the room-player base before its subclass；改动4文件；本地列举分支中独占提交。

内容已覆盖文件：

- `scripts/native-christmas/audit-candidate.mjs`
- `scripts/native-christmas/build-library.mjs`
- `scripts/native-christmas/extract-resources.mjs`
- `scripts/native-christmas/library-order.test.mjs`

内容不一致文件（详细摘要见上表）：

- 无。

### codex/core-playability-zh

头 `d073d92645013b1c3b45b4e9aea38703e2ec2582`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `edabd1a81a47` fix(workshop): expose activity tasks and translate room feedback；改动4文件；其它分支也包含此提交。
- `cb9f57e2643d` Translate core login and battle feedback into Chinese；改动1文件；其它分支也包含此提交。
- `1d431f768290` Localize runtime battle effect and insufficient-money messages；改动4文件；其它分支也包含此提交。
- `40aa5ac255be` fix(i18n): clarify cave materials and footer rules；改动3文件；其它分支也包含此提交。
- `c7628498c0d5` fix(i18n): translate the native flight prop tooltip；改动2文件；其它分支也包含此提交。
- `7755f786cfc0` fix(i18n): translate the native extra attack tooltip；改动2文件；其它分支也包含此提交。
- `ec6c76c4722d` fix(i18n): complete native battle toolbar prop text；改动2文件；其它分支也包含此提交。
- `f56f10dd7f33` fix(i18n): translate activity potion names and experience feedback；改动3文件；其它分支也包含此提交。
- `cf533e622fc9` fix(i18n): translate common activity material descriptions；改动2文件；其它分支也包含此提交。
- `8746f0c64956` fix(i18n): translate cumulative sign reward materials；改动2文件；其它分支也包含此提交。
- `458e5b1d4a12` fix(i18n): translate mail and item-use feedback；改动1文件；其它分支也包含此提交。
- `77aa846ff6e6` fix(i18n): translate pet feeding feedback；改动1文件；其它分支也包含此提交。
- `6145758a85b8` fix(i18n): translate original email window captions；改动5文件；其它分支也包含此提交。
- `a5f0c08501d6` fix(i18n): localize claim feedback and verify battle reward persistence；改动5文件；其它分支也包含此提交。
- `fff12cebde49` fix(events): reject unconfigured first recharge gifts before claiming；改动7文件；其它分支也包含此提交。
- `d073d9264501` fix(i18n): translate displayed game content and interface into Chinese；改动92文件；其它分支也包含此提交。

内容已覆盖文件：

- `apps/admin/src/crud/FieldInput.tsx`
- `apps/admin/src/crud/schema.ts`
- `apps/admin/src/mocks/db.ts`
- `apps/admin/src/mocks/handlers.ts`
- `apps/admin/src/pages/Dashboard.tsx`
- `apps/admin/src/pages/Events.tsx`
- `apps/admin/src/pages/Mail.tsx`
- `apps/admin/src/pages/ServerConfig.tsx`
- `apps/admin/src/resources/content.ts`
- `apps/admin/src/resources/event-systems.ts`
- `apps/admin/src/resources/guilds.ts`
- `apps/admin/src/resources/items.ts`
- `apps/admin/src/resources/players.ts`
- `apps/admin/src/resources/system.tsx`
- `apps/admin/test/api-chinese-errors.test.ts`
- `apps/admin/test/i18n.test.ts`
- `apps/api/src/routes/admin-resources.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/test/chinese-display-overlay.test.ts`
- `apps/api/test/item-name-overlay.test.ts`
- `apps/api/test/template-text-overlay.test.ts`
- `apps/game/src/db/consortia.ts`
- `apps/game/src/game/cards.ts`
- `apps/game/src/game/consortia-mgr.ts`
- `apps/game/src/game/consortia.ts`
- `apps/game/src/game/world-boss-rewards.ts`
- `apps/game/src/handlers/academy.ts`
- `apps/game/src/handlers/activities.ts`
- `apps/game/src/handlers/auction.ts`
- `apps/game/src/handlers/basic.ts`
- `apps/game/src/handlers/consortia.ts`
- `apps/game/src/handlers/farm.ts`
- `apps/game/src/handlers/hotspring.ts`
- `apps/game/src/handlers/mail.ts`
- `apps/game/src/handlers/marriage.ts`
- `apps/game/test/events-feedback.test.ts`
- `apps/game/test/fight.test.ts`
- `apps/game/test/first-recharge-config.test.ts`
- `apps/game/test/first-recharge-login.test.ts`
- `apps/web/index.html`
- `apps/web/src/components/GameFrame.tsx`
- `apps/web/src/components/SiteLayout.tsx`
- `apps/web/src/mocks/handlers.ts`
- `apps/web/src/pages/Play.native-menu.test.tsx`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GAH1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GK1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GT1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KD1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KT1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAEpic13402.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAH13202.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAN13102.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAS13002.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAT13302.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhHardLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhNormalLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhSimpleLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirdNormalBloomNpcS2.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorBrynBoss.ts`
- `packages/fight/test/equip-language.test.ts`
- `packages/ui/src/api.ts`
- `packages/ui/src/components/dialog.tsx`
- `packages/ui/src/components/misc.tsx`
- `packages/ui/src/i18n.tsx`
- `research/i18n/bag-art/email.zh-CN.json`
- `research/i18n/bag-art/email/5.png`
- `research/i18n/bag-art/email/54.png`
- `research/i18n/zh-CN-item-names.json`
- `research/i18n/zh-CN-pve-overrides.json`
- `research/i18n/zh-CN-server-additions.json`
- `research/i18n/zh-CN-server-row-overrides.json`
- `scripts/workshop-bag-art.mjs`
- `scripts/workshop-client-chinese-coverage.test.mjs`
- `scripts/workshop-email-art.test.mjs`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/templates/defs.ts`：D05；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/db/templates.ts`：D06；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/game/events.ts`：D07；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/events.ts`：D08；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/forge.ts`：D09；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/handlers/pets.ts`：D10；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/rooms.ts`：D01；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/use.ts`：D11；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/server.ts`：D12；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/session/login.ts`：D13；branch_patch_present_with_additional_workspace_changes。
- `apps/web/src/pages/Play.tsx`：D02；branch_patch_present_with_additional_workspace_changes。
- `docs/workshop.zh-CN.md`：D14；branch_patch_present_with_additional_workspace_changes。
- `packages/db/src/translations.ts`：D15；superseded_by_exact_other_branch_result。
- `packages/db/test/template-text.test.ts`：D16；superseded_by_exact_other_branch_result。
- `packages/fight/src/game/equipEffects.ts`：D17；branch_patch_present_with_additional_workspace_changes。
- `research/i18n/zh-CN-overrides.json`：D18；superseded_by_exact_other_branch_result。
- `research/i18n/zh-CN-server-overrides.json`：D19；branch_records_preserved_with_additions。
- `research/i18n/zh-CN-template-text.json`：D20；branch_patch_present_with_additional_workspace_changes。
- `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as`：D21；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.mjs`：D22；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.test.mjs`：D23；superseded_by_exact_other_branch_result。

### codex/devil-normal-play

头 `cc202c60c98efad304c680e81066f066a636d1f3`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `68e9560165ee` fix(devil): pass required shop item identities before opening；改动3文件；其它分支也包含此提交。
- `67b96721f5c0` fix(devil): load support parents before purchase views；改动3文件；其它分支也包含此提交。
- `c7296ccfbd65` fix(devil): resolve original activity coordinates after isolation；改动2文件；本地列举分支中独占提交。
- `cc202c60c98e` fix(native-ui): close original shops with supported HBox cleanup；改动3文件；本地列举分支中独占提交。

内容已覆盖文件：

- `scripts/native-devil/WorkshopNativeDevilBootstrap.as`
- `scripts/native-devil/audit-candidate.mjs`
- `scripts/native-devil/build-library.mjs`
- `scripts/native-devil/library-load-order.test.mjs`
- `scripts/native-devil/position-host.test.mjs`
- `scripts/native-devil/shop-item-host.test.mjs`
- `scripts/native-pair/build-library.mjs`
- `scripts/native-shared/build-library.mjs`
- `scripts/native-shared/page-navigater-dispose.test.mjs`

内容不一致文件（详细摘要见上表）：

- 无。

### codex/devil-shop-host

头 `67b96721f5c04e074cc24ee2da705089bb703fb1`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `68e9560165ee` fix(devil): pass required shop item identities before opening；改动3文件；其它分支也包含此提交。
- `67b96721f5c0` fix(devil): load support parents before purchase views；改动3文件；其它分支也包含此提交。

内容已覆盖文件：

- `scripts/native-devil/audit-candidate.mjs`
- `scripts/native-devil/build-library.mjs`
- `scripts/native-devil/library-load-order.test.mjs`
- `scripts/native-devil/shop-item-host.test.mjs`

内容不一致文件（详细摘要见上表）：

- `scripts/native-devil/WorkshopNativeDevilBootstrap.as`：D24；branch_patch_present_with_additional_workspace_changes。

### codex/feedback-display-text

头 `91fe08f32f4e031ddc5eb94381134998fc5c47c0`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `edabd1a81a47` fix(workshop): expose activity tasks and translate room feedback；改动4文件；其它分支也包含此提交。
- `cb9f57e2643d` Translate core login and battle feedback into Chinese；改动1文件；其它分支也包含此提交。
- `1d431f768290` Localize runtime battle effect and insufficient-money messages；改动4文件；其它分支也包含此提交。
- `40aa5ac255be` fix(i18n): clarify cave materials and footer rules；改动3文件；其它分支也包含此提交。
- `c7628498c0d5` fix(i18n): translate the native flight prop tooltip；改动2文件；其它分支也包含此提交。
- `7755f786cfc0` fix(i18n): translate the native extra attack tooltip；改动2文件；其它分支也包含此提交。
- `ec6c76c4722d` fix(i18n): complete native battle toolbar prop text；改动2文件；其它分支也包含此提交。
- `f56f10dd7f33` fix(i18n): translate activity potion names and experience feedback；改动3文件；其它分支也包含此提交。
- `cf533e622fc9` fix(i18n): translate common activity material descriptions；改动2文件；其它分支也包含此提交。
- `8746f0c64956` fix(i18n): translate cumulative sign reward materials；改动2文件；其它分支也包含此提交。
- `458e5b1d4a12` fix(i18n): translate mail and item-use feedback；改动1文件；其它分支也包含此提交。
- `77aa846ff6e6` fix(i18n): translate pet feeding feedback；改动1文件；其它分支也包含此提交。
- `6145758a85b8` fix(i18n): translate original email window captions；改动5文件；其它分支也包含此提交。
- `a5f0c08501d6` fix(i18n): localize claim feedback and verify battle reward persistence；改动5文件；其它分支也包含此提交。
- `fff12cebde49` fix(events): reject unconfigured first recharge gifts before claiming；改动7文件；其它分支也包含此提交。
- `d073d9264501` fix(i18n): translate displayed game content and interface into Chinese；改动92文件；其它分支也包含此提交。
- `805b2d537308` Fix Chinese card, title, item detail and dictionary feedback；改动16文件；本地列举分支中独占提交。
- `1aa471eaeb62` Localize room and forge display assets without changing client behavior；改动6文件；本地列举分支中独占提交。
- `e9cf1806afcb` Prepare captured official bubble tea physics and effects through owned startup upgrade；改动6文件；本地列举分支中独占提交。
- `703aebf2c929` Require particle evidence to cover the selected official emitters；改动2文件；本地列举分支中独占提交。
- `91fe08f32f4e` Record approved normal restart and official effects readback；改动1文件；本地列举分支中独占提交。

内容已覆盖文件：

- `apps/admin/src/crud/FieldInput.tsx`
- `apps/admin/src/crud/schema.ts`
- `apps/admin/src/mocks/db.ts`
- `apps/admin/src/mocks/handlers.ts`
- `apps/admin/src/pages/Dashboard.tsx`
- `apps/admin/src/pages/Events.tsx`
- `apps/admin/src/pages/Mail.tsx`
- `apps/admin/src/pages/ServerConfig.tsx`
- `apps/admin/src/resources/content.ts`
- `apps/admin/src/resources/event-systems.ts`
- `apps/admin/src/resources/guilds.ts`
- `apps/admin/src/resources/items.ts`
- `apps/admin/src/resources/players.ts`
- `apps/admin/src/resources/system.tsx`
- `apps/admin/test/api-chinese-errors.test.ts`
- `apps/admin/test/i18n.test.ts`
- `apps/api/assets/flash/ui/vietnam/swf/ddtstore.swf`
- `apps/api/assets/flash/ui/vietnam/swf/room.swf`
- `apps/api/assets/flash/ui/vietnam/swf/roomlist.swf`
- `apps/api/assets/flash/ui/vietnam/swf/store.swf`
- `apps/api/assets/flash/ui/vietnam/swf/storefinebringup.swf`
- `apps/api/assets/request/cardinfolist.xml`
- `apps/api/src/routes/admin-resources.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/templates/defs.ts`
- `apps/api/test/chinese-display-overlay.test.ts`
- `apps/api/test/feedback-display-text.test.ts`
- `apps/api/test/item-name-overlay.test.ts`
- `apps/api/test/template-text-overlay.test.ts`
- `apps/game/src/db/consortia.ts`
- `apps/game/src/game/cards.ts`
- `apps/game/src/game/consortia-mgr.ts`
- `apps/game/src/game/consortia.ts`
- `apps/game/src/game/events.ts`
- `apps/game/src/game/world-boss-rewards.ts`
- `apps/game/src/handlers/academy.ts`
- `apps/game/src/handlers/activities.ts`
- `apps/game/src/handlers/auction.ts`
- `apps/game/src/handlers/basic.ts`
- `apps/game/src/handlers/consortia.ts`
- `apps/game/src/handlers/events.ts`
- `apps/game/src/handlers/farm.ts`
- `apps/game/src/handlers/hotspring.ts`
- `apps/game/src/handlers/mail.ts`
- `apps/game/src/handlers/marriage.ts`
- `apps/game/test/achievement-title-display.test.ts`
- `apps/game/test/events-feedback.test.ts`
- `apps/game/test/fight.test.ts`
- `apps/game/test/first-recharge-config.test.ts`
- `apps/game/test/first-recharge-login.test.ts`
- `apps/web/index.html`
- `apps/web/src/components/GameFrame.tsx`
- `apps/web/src/components/SiteLayout.tsx`
- `apps/web/src/mocks/handlers.ts`
- `apps/web/src/pages/Play.native-menu.test.tsx`
- `docs/workshop.zh-CN.md`
- `packages/db/src/template-display-data.ts`
- `packages/db/src/translations.ts`
- `packages/db/test/template-text.test.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GAH1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GK1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GT1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KD1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KT1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAEpic13402.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAH13202.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAN13102.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAS13002.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAT13302.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhHardLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhNormalLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhSimpleLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirdNormalBloomNpcS2.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorBrynBoss.ts`
- `packages/fight/test/equip-language.test.ts`
- `packages/ui/src/api.ts`
- `packages/ui/src/components/dialog.tsx`
- `packages/ui/src/components/misc.tsx`
- `packages/ui/src/i18n.tsx`
- `research/i18n/bag-art/email.zh-CN.json`
- `research/i18n/bag-art/email/5.png`
- `research/i18n/bag-art/email/54.png`
- `research/i18n/zh-CN-dictionary-format-repairs.json`
- `research/i18n/zh-CN-feedback-text.json`
- `research/i18n/zh-CN-item-names.json`
- `research/i18n/zh-CN-overrides.json`
- `research/i18n/zh-CN-pve-overrides.json`
- `research/i18n/zh-CN-room-forge-assets.json`
- `research/i18n/zh-CN-server-additions.json`
- `research/i18n/zh-CN-server-overrides.json`
- `research/i18n/zh-CN-server-row-overrides.json`
- `research/weapon-bubble-tea-official-effects.md`
- `scripts/workshop-bag-art.mjs`
- `scripts/workshop-client-chinese-coverage.test.mjs`
- `scripts/workshop-email-art.test.mjs`
- `scripts/workshop-language.mjs`
- `scripts/workshop-language.test.mjs`
- `scripts/workshop-weapon-effects.test.ts`
- `scripts/workshop-weapon-effects.ts`
- `scripts/workshop-weapon-smith.ts`
- `scripts/workshop-weapon-visual-startup.test.ts`
- `scripts/workshop-weapon-visual-startup.ts`

内容不一致文件（详细摘要见上表）：

- `apps/game/src/db/templates.ts`：D06；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/forge.ts`：D09；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/handlers/pets.ts`：D10；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/rooms.ts`：D01；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/use.ts`：D11；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/server.ts`：D12；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/session/login.ts`：D13；branch_patch_present_with_additional_workspace_changes。
- `apps/web/src/pages/Play.tsx`：D02；branch_patch_present_with_additional_workspace_changes。
- `packages/fight/src/game/equipEffects.ts`：D17；branch_patch_present_with_additional_workspace_changes。
- `research/i18n/zh-CN-template-text.json`：D20；branch_patch_present_with_additional_workspace_changes。
- `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as`：D21；branch_patch_present_with_additional_workspace_changes。

### codex/game-energy-label

头 `0ed1dd7906614c512981435b76d1810d50e3fe7d`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `edabd1a81a47` fix(workshop): expose activity tasks and translate room feedback；改动4文件；其它分支也包含此提交。
- `cb9f57e2643d` Translate core login and battle feedback into Chinese；改动1文件；其它分支也包含此提交。
- `1d431f768290` Localize runtime battle effect and insufficient-money messages；改动4文件；其它分支也包含此提交。
- `40aa5ac255be` fix(i18n): clarify cave materials and footer rules；改动3文件；其它分支也包含此提交。
- `c7628498c0d5` fix(i18n): translate the native flight prop tooltip；改动2文件；其它分支也包含此提交。
- `7755f786cfc0` fix(i18n): translate the native extra attack tooltip；改动2文件；其它分支也包含此提交。
- `ec6c76c4722d` fix(i18n): complete native battle toolbar prop text；改动2文件；其它分支也包含此提交。
- `f56f10dd7f33` fix(i18n): translate activity potion names and experience feedback；改动3文件；其它分支也包含此提交。
- `cf533e622fc9` fix(i18n): translate common activity material descriptions；改动2文件；其它分支也包含此提交。
- `8746f0c64956` fix(i18n): translate cumulative sign reward materials；改动2文件；其它分支也包含此提交。
- `458e5b1d4a12` fix(i18n): translate mail and item-use feedback；改动1文件；其它分支也包含此提交。
- `77aa846ff6e6` fix(i18n): translate pet feeding feedback；改动1文件；其它分支也包含此提交。
- `6145758a85b8` fix(i18n): translate original email window captions；改动5文件；其它分支也包含此提交。
- `a5f0c08501d6` fix(i18n): localize claim feedback and verify battle reward persistence；改动5文件；其它分支也包含此提交。
- `fff12cebde49` fix(events): reject unconfigured first recharge gifts before claiming；改动7文件；其它分支也包含此提交。
- `d073d9264501` fix(i18n): translate displayed game content and interface into Chinese；改动92文件；其它分支也包含此提交。
- `1d091e545264` Fix imported weapon smith access and battle music transitions；改动8文件；其它分支也包含此提交。
- `7fea253ebce5` Fix coupon purchases, prop projectile selection and tooltip feedback；改动13文件；其它分支也包含此提交。
- `0ed1dd790661` Restore original Chinese insufficient-energy combat label；改动1文件；本地列举分支中独占提交。

内容已覆盖文件：

- `apps/admin/src/crud/FieldInput.tsx`
- `apps/admin/src/crud/schema.ts`
- `apps/admin/src/mocks/db.ts`
- `apps/admin/src/mocks/handlers.ts`
- `apps/admin/src/pages/Dashboard.tsx`
- `apps/admin/src/pages/Events.tsx`
- `apps/admin/src/pages/Mail.tsx`
- `apps/admin/src/pages/ServerConfig.tsx`
- `apps/admin/src/resources/content.ts`
- `apps/admin/src/resources/event-systems.ts`
- `apps/admin/src/resources/guilds.ts`
- `apps/admin/src/resources/items.ts`
- `apps/admin/src/resources/players.ts`
- `apps/admin/src/resources/system.tsx`
- `apps/admin/test/api-chinese-errors.test.ts`
- `apps/admin/test/i18n.test.ts`
- `apps/api/src/routes/admin-resources.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/test/chinese-display-overlay.test.ts`
- `apps/api/test/item-name-overlay.test.ts`
- `apps/api/test/template-text-overlay.test.ts`
- `apps/game/src/db/consortia.ts`
- `apps/game/src/game/cards.ts`
- `apps/game/src/game/consortia-mgr.ts`
- `apps/game/src/game/consortia.ts`
- `apps/game/src/game/world-boss-rewards.ts`
- `apps/game/src/handlers/academy.ts`
- `apps/game/src/handlers/activities.ts`
- `apps/game/src/handlers/auction.ts`
- `apps/game/src/handlers/basic.ts`
- `apps/game/src/handlers/consortia.ts`
- `apps/game/src/handlers/farm.ts`
- `apps/game/src/handlers/hotspring.ts`
- `apps/game/src/handlers/mail.ts`
- `apps/game/src/handlers/marriage.ts`
- `apps/game/src/handlers/shop-shortcuts.ts`
- `apps/game/test/events-feedback.test.ts`
- `apps/game/test/fight.test.ts`
- `apps/game/test/first-recharge-config.test.ts`
- `apps/game/test/first-recharge-login.test.ts`
- `apps/game/test/shop-shortcuts.test.ts`
- `apps/web/index.html`
- `apps/web/src/components/GameFrame.tsx`
- `apps/web/src/components/SiteLayout.tsx`
- `apps/web/src/mocks/handlers.ts`
- `apps/web/src/pages/Play.native-menu.test.tsx`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GAH1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GK1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GT1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KD1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KT1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAEpic13402.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAH13202.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAN13102.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAS13002.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAT13302.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhHardLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhNormalLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhSimpleLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirdNormalBloomNpcS2.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorBrynBoss.ts`
- `packages/fight/test/equip-language.test.ts`
- `packages/fight/test/prop-projectile.test.ts`
- `packages/ui/src/api.ts`
- `packages/ui/src/components/dialog.tsx`
- `packages/ui/src/components/misc.tsx`
- `packages/ui/src/i18n.tsx`
- `research/i18n/bag-art/email.zh-CN.json`
- `research/i18n/bag-art/email/5.png`
- `research/i18n/bag-art/email/54.png`
- `research/i18n/tooltip-quest-art/smooth-labels.zh-CN.json`
- `research/i18n/zh-CN-item-names.json`
- `research/i18n/zh-CN-pve-overrides.json`
- `research/i18n/zh-CN-server-additions.json`
- `research/i18n/zh-CN-server-row-overrides.json`
- `research/i18n/zh-CN-template-text.json`
- `scripts/workshop-bag-art.mjs`
- `scripts/workshop-battle-music.test.mjs`
- `scripts/workshop-client-chinese-coverage.test.mjs`
- `scripts/workshop-email-art.test.mjs`
- `scripts/workshop-game-energy-text.mjs`
- `scripts/workshop-literals.mjs`
- `scripts/workshop-smith-gift-price.test.mjs`
- `scripts/workshop-tooltip-labels.mjs`
- `scripts/workshop-tooltip-labels.test.mjs`
- `scripts/workshop-weapon-audio.test.mjs`
- `scripts/workshop-weapon-smith.ts`
- `scripts/workshop-weapon-visuals.test.ts`
- `scripts/workshop-weapon-visuals.ts`
- `tools/i18n/abc-strings/battle-music.mjs`
- `tools/i18n/abc-strings/smith-gift-price.mjs`
- `tools/i18n/abc-strings/weapon-audio.mjs`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/templates/defs.ts`：D05；branch_patch_present_with_additional_workspace_changes。
- `apps/game/HANDLERS.md`：D25；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/db/templates.ts`：D06；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/game/events.ts`：D07；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/events.ts`：D08；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/forge.ts`：D09；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/handlers/items.ts`：D26；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/pets.ts`：D10；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/rooms.ts`：D01；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/use.ts`：D11；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/server.ts`：D12；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/session/login.ts`：D13；branch_patch_present_with_additional_workspace_changes。
- `apps/web/src/pages/Play.tsx`：D02；branch_patch_present_with_additional_workspace_changes。
- `docs/workshop.zh-CN.md`：D14；branch_patch_present_with_additional_workspace_changes。
- `packages/db/src/translations.ts`：D15；superseded_by_exact_other_branch_result。
- `packages/db/test/template-text.test.ts`：D16；superseded_by_exact_other_branch_result。
- `packages/fight/src/game/equipEffects.ts`：D17；branch_patch_present_with_additional_workspace_changes。
- `packages/fight/src/game/game.ts`：D27；branch_patch_present_with_additional_workspace_changes。
- `research/i18n/zh-CN-overrides.json`：D18；superseded_by_exact_other_branch_result。
- `research/i18n/zh-CN-server-overrides.json`：D19；branch_records_preserved_with_additions。
- `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as`：D21；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.mjs`：D22；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.test.mjs`：D23；superseded_by_exact_other_branch_result。

### codex/hall-night-hover

头 `c4a7793f9c3f1e1286cf6f46352430061a71ebcb`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `edabd1a81a47` fix(workshop): expose activity tasks and translate room feedback；改动4文件；其它分支也包含此提交。
- `cb9f57e2643d` Translate core login and battle feedback into Chinese；改动1文件；其它分支也包含此提交。
- `1d431f768290` Localize runtime battle effect and insufficient-money messages；改动4文件；其它分支也包含此提交。
- `40aa5ac255be` fix(i18n): clarify cave materials and footer rules；改动3文件；其它分支也包含此提交。
- `c7628498c0d5` fix(i18n): translate the native flight prop tooltip；改动2文件；其它分支也包含此提交。
- `7755f786cfc0` fix(i18n): translate the native extra attack tooltip；改动2文件；其它分支也包含此提交。
- `ec6c76c4722d` fix(i18n): complete native battle toolbar prop text；改动2文件；其它分支也包含此提交。
- `f56f10dd7f33` fix(i18n): translate activity potion names and experience feedback；改动3文件；其它分支也包含此提交。
- `cf533e622fc9` fix(i18n): translate common activity material descriptions；改动2文件；其它分支也包含此提交。
- `8746f0c64956` fix(i18n): translate cumulative sign reward materials；改动2文件；其它分支也包含此提交。
- `458e5b1d4a12` fix(i18n): translate mail and item-use feedback；改动1文件；其它分支也包含此提交。
- `77aa846ff6e6` fix(i18n): translate pet feeding feedback；改动1文件；其它分支也包含此提交。
- `6145758a85b8` fix(i18n): translate original email window captions；改动5文件；其它分支也包含此提交。
- `a5f0c08501d6` fix(i18n): localize claim feedback and verify battle reward persistence；改动5文件；其它分支也包含此提交。
- `fff12cebde49` fix(events): reject unconfigured first recharge gifts before claiming；改动7文件；其它分支也包含此提交。
- `d073d9264501` fix(i18n): translate displayed game content and interface into Chinese；改动92文件；其它分支也包含此提交。
- `c4a7793f9c3f` Fix night hall hover art and wedding tooltip；改动4文件；本地列举分支中独占提交。

内容已覆盖文件：

- `apps/admin/src/crud/FieldInput.tsx`
- `apps/admin/src/crud/schema.ts`
- `apps/admin/src/mocks/db.ts`
- `apps/admin/src/mocks/handlers.ts`
- `apps/admin/src/pages/Dashboard.tsx`
- `apps/admin/src/pages/Events.tsx`
- `apps/admin/src/pages/Mail.tsx`
- `apps/admin/src/pages/ServerConfig.tsx`
- `apps/admin/src/resources/content.ts`
- `apps/admin/src/resources/event-systems.ts`
- `apps/admin/src/resources/guilds.ts`
- `apps/admin/src/resources/items.ts`
- `apps/admin/src/resources/players.ts`
- `apps/admin/src/resources/system.tsx`
- `apps/admin/test/api-chinese-errors.test.ts`
- `apps/admin/test/i18n.test.ts`
- `apps/api/src/routes/admin-resources.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/test/chinese-display-overlay.test.ts`
- `apps/api/test/item-name-overlay.test.ts`
- `apps/api/test/template-text-overlay.test.ts`
- `apps/game/src/db/consortia.ts`
- `apps/game/src/game/cards.ts`
- `apps/game/src/game/consortia-mgr.ts`
- `apps/game/src/game/consortia.ts`
- `apps/game/src/game/world-boss-rewards.ts`
- `apps/game/src/handlers/academy.ts`
- `apps/game/src/handlers/activities.ts`
- `apps/game/src/handlers/auction.ts`
- `apps/game/src/handlers/basic.ts`
- `apps/game/src/handlers/consortia.ts`
- `apps/game/src/handlers/farm.ts`
- `apps/game/src/handlers/hotspring.ts`
- `apps/game/src/handlers/mail.ts`
- `apps/game/src/handlers/marriage.ts`
- `apps/game/test/events-feedback.test.ts`
- `apps/game/test/fight.test.ts`
- `apps/game/test/first-recharge-config.test.ts`
- `apps/game/test/first-recharge-login.test.ts`
- `apps/web/index.html`
- `apps/web/src/components/GameFrame.tsx`
- `apps/web/src/components/SiteLayout.tsx`
- `apps/web/src/mocks/handlers.ts`
- `apps/web/src/pages/Play.native-menu.test.tsx`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GAH1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GK1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GT1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KD1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KT1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAEpic13402.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAH13202.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAN13102.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAS13002.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAT13302.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhHardLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhNormalLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhSimpleLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirdNormalBloomNpcS2.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorBrynBoss.ts`
- `packages/fight/test/equip-language.test.ts`
- `packages/ui/src/api.ts`
- `packages/ui/src/components/dialog.tsx`
- `packages/ui/src/components/misc.tsx`
- `packages/ui/src/i18n.tsx`
- `research/i18n/bag-art/email.zh-CN.json`
- `research/i18n/bag-art/email/5.png`
- `research/i18n/bag-art/email/54.png`
- `research/i18n/hall-hover/README.md`
- `research/i18n/hall-hover/night.zh-CN.json`
- `research/i18n/zh-CN-item-names.json`
- `research/i18n/zh-CN-pve-overrides.json`
- `research/i18n/zh-CN-server-additions.json`
- `research/i18n/zh-CN-server-row-overrides.json`
- `scripts/workshop-bag-art.mjs`
- `scripts/workshop-client-chinese-coverage.test.mjs`
- `scripts/workshop-email-art.test.mjs`
- `scripts/workshop-hall-hover.mjs`
- `scripts/workshop-hall-hover.test.mjs`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/templates/defs.ts`：D05；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/db/templates.ts`：D06；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/game/events.ts`：D07；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/events.ts`：D08；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/forge.ts`：D09；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/handlers/pets.ts`：D10；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/rooms.ts`：D01；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/use.ts`：D11；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/server.ts`：D12；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/session/login.ts`：D13；branch_patch_present_with_additional_workspace_changes。
- `apps/web/src/pages/Play.tsx`：D02；branch_patch_present_with_additional_workspace_changes。
- `docs/workshop.zh-CN.md`：D14；branch_patch_present_with_additional_workspace_changes。
- `packages/db/src/translations.ts`：D15；superseded_by_exact_other_branch_result。
- `packages/db/test/template-text.test.ts`：D16；superseded_by_exact_other_branch_result。
- `packages/fight/src/game/equipEffects.ts`：D17；branch_patch_present_with_additional_workspace_changes。
- `research/i18n/zh-CN-overrides.json`：D18；superseded_by_exact_other_branch_result。
- `research/i18n/zh-CN-server-overrides.json`：D19；branch_records_preserved_with_additions。
- `research/i18n/zh-CN-template-text.json`：D20；branch_patch_present_with_additional_workspace_changes。
- `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as`：D21；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.mjs`：D22；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.test.mjs`：D23；superseded_by_exact_other_branch_result。

### codex/local-workshop

头 `1585d30c1ea3ff0134b72724fd0c9770fb8342dd`；共同基点 `1585d30c1ea3ff0134b72724fd0c9770fb8342dd`。

共同基点之后提交（可能被其它分支继承）：

- 无；当前冻结基线。

内容已覆盖文件：

- 无或为基线。

内容不一致文件（详细摘要见上表）：

- 无。

### codex/mines-playable-layout

头 `d1dd8ea849ac3b98dd68101ec9b12f2abd3cb2f2`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `edabd1a81a47` fix(workshop): expose activity tasks and translate room feedback；改动4文件；其它分支也包含此提交。
- `cb9f57e2643d` Translate core login and battle feedback into Chinese；改动1文件；其它分支也包含此提交。
- `d1dd8ea849ac` fix(mines): keep health visible in native activity window；改动1文件；本地列举分支中独占提交。

内容已覆盖文件：

- `apps/web/src/pages/Play.native-menu.test.tsx`
- `scripts/native-mines/WorkshopNativeMinesBootstrap.as`

内容不一致文件（详细摘要见上表）：

- `apps/game/src/handlers/rooms.ts`：D01；branch_patch_present_with_additional_workspace_changes。
- `apps/web/src/pages/Play.tsx`：D02；branch_patch_present_with_additional_workspace_changes。
- `research/i18n/zh-CN-server-overrides.json`：D03；superseded_by_exact_other_branch_result。

### codex/moonlight-normal-play

头 `3a9aea8b0b54392419705c4245c5b69c25ec0f65`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `a71eb2ad9025` fix(moonlight): honor required shop item constructor identities；改动3文件；其它分支也包含此提交。
- `3a9aea8b0b54` fix(moonlight): load native window and render real shop rows；改动5文件；本地列举分支中独占提交。

内容已覆盖文件：

- `scripts/native-moonlight/WorkshopNativeMoonlightBootstrap.as`
- `scripts/native-moonlight/audit-candidate.mjs`
- `scripts/native-moonlight/build-library.mjs`
- `scripts/native-moonlight/library-order.test.mjs`
- `scripts/native-moonlight/shop-item-host.test.mjs`

内容不一致文件（详细摘要见上表）：

- 无。

### codex/moonlight-shop-host

头 `a71eb2ad90256de3684b6f60f75ab01b7dbdf659`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `a71eb2ad9025` fix(moonlight): honor required shop item constructor identities；改动3文件；其它分支也包含此提交。

内容已覆盖文件：

- 无或为基线。

内容不一致文件（详细摘要见上表）：

- `scripts/native-moonlight/WorkshopNativeMoonlightBootstrap.as`：D28；branch_patch_present_with_additional_workspace_changes。
- `scripts/native-moonlight/audit-candidate.mjs`：D29；branch_patch_present_with_additional_workspace_changes。
- `scripts/native-moonlight/shop-item-host.test.mjs`：D30；superseded_by_exact_other_branch_result。

### codex/playtest-purchases-props-tooltip

头 `7fea253ebce591242c9bc19d73c28e36ea21a8f2`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `edabd1a81a47` fix(workshop): expose activity tasks and translate room feedback；改动4文件；其它分支也包含此提交。
- `cb9f57e2643d` Translate core login and battle feedback into Chinese；改动1文件；其它分支也包含此提交。
- `1d431f768290` Localize runtime battle effect and insufficient-money messages；改动4文件；其它分支也包含此提交。
- `40aa5ac255be` fix(i18n): clarify cave materials and footer rules；改动3文件；其它分支也包含此提交。
- `c7628498c0d5` fix(i18n): translate the native flight prop tooltip；改动2文件；其它分支也包含此提交。
- `7755f786cfc0` fix(i18n): translate the native extra attack tooltip；改动2文件；其它分支也包含此提交。
- `ec6c76c4722d` fix(i18n): complete native battle toolbar prop text；改动2文件；其它分支也包含此提交。
- `f56f10dd7f33` fix(i18n): translate activity potion names and experience feedback；改动3文件；其它分支也包含此提交。
- `cf533e622fc9` fix(i18n): translate common activity material descriptions；改动2文件；其它分支也包含此提交。
- `8746f0c64956` fix(i18n): translate cumulative sign reward materials；改动2文件；其它分支也包含此提交。
- `458e5b1d4a12` fix(i18n): translate mail and item-use feedback；改动1文件；其它分支也包含此提交。
- `77aa846ff6e6` fix(i18n): translate pet feeding feedback；改动1文件；其它分支也包含此提交。
- `6145758a85b8` fix(i18n): translate original email window captions；改动5文件；其它分支也包含此提交。
- `a5f0c08501d6` fix(i18n): localize claim feedback and verify battle reward persistence；改动5文件；其它分支也包含此提交。
- `fff12cebde49` fix(events): reject unconfigured first recharge gifts before claiming；改动7文件；其它分支也包含此提交。
- `d073d9264501` fix(i18n): translate displayed game content and interface into Chinese；改动92文件；其它分支也包含此提交。
- `1d091e545264` Fix imported weapon smith access and battle music transitions；改动8文件；其它分支也包含此提交。
- `7fea253ebce5` Fix coupon purchases, prop projectile selection and tooltip feedback；改动13文件；其它分支也包含此提交。

内容已覆盖文件：

- `apps/admin/src/crud/FieldInput.tsx`
- `apps/admin/src/crud/schema.ts`
- `apps/admin/src/mocks/db.ts`
- `apps/admin/src/mocks/handlers.ts`
- `apps/admin/src/pages/Dashboard.tsx`
- `apps/admin/src/pages/Events.tsx`
- `apps/admin/src/pages/Mail.tsx`
- `apps/admin/src/pages/ServerConfig.tsx`
- `apps/admin/src/resources/content.ts`
- `apps/admin/src/resources/event-systems.ts`
- `apps/admin/src/resources/guilds.ts`
- `apps/admin/src/resources/items.ts`
- `apps/admin/src/resources/players.ts`
- `apps/admin/src/resources/system.tsx`
- `apps/admin/test/api-chinese-errors.test.ts`
- `apps/admin/test/i18n.test.ts`
- `apps/api/src/routes/admin-resources.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/test/chinese-display-overlay.test.ts`
- `apps/api/test/item-name-overlay.test.ts`
- `apps/api/test/template-text-overlay.test.ts`
- `apps/game/src/db/consortia.ts`
- `apps/game/src/game/cards.ts`
- `apps/game/src/game/consortia-mgr.ts`
- `apps/game/src/game/consortia.ts`
- `apps/game/src/game/world-boss-rewards.ts`
- `apps/game/src/handlers/academy.ts`
- `apps/game/src/handlers/activities.ts`
- `apps/game/src/handlers/auction.ts`
- `apps/game/src/handlers/basic.ts`
- `apps/game/src/handlers/consortia.ts`
- `apps/game/src/handlers/farm.ts`
- `apps/game/src/handlers/hotspring.ts`
- `apps/game/src/handlers/mail.ts`
- `apps/game/src/handlers/marriage.ts`
- `apps/game/src/handlers/shop-shortcuts.ts`
- `apps/game/test/events-feedback.test.ts`
- `apps/game/test/fight.test.ts`
- `apps/game/test/first-recharge-config.test.ts`
- `apps/game/test/first-recharge-login.test.ts`
- `apps/game/test/shop-shortcuts.test.ts`
- `apps/web/index.html`
- `apps/web/src/components/GameFrame.tsx`
- `apps/web/src/components/SiteLayout.tsx`
- `apps/web/src/mocks/handlers.ts`
- `apps/web/src/pages/Play.native-menu.test.tsx`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GAH1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GK1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GT1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KD1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KT1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAEpic13402.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAH13202.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAN13102.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAS13002.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAT13302.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhHardLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhNormalLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhSimpleLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirdNormalBloomNpcS2.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorBrynBoss.ts`
- `packages/fight/test/equip-language.test.ts`
- `packages/fight/test/prop-projectile.test.ts`
- `packages/ui/src/api.ts`
- `packages/ui/src/components/dialog.tsx`
- `packages/ui/src/components/misc.tsx`
- `packages/ui/src/i18n.tsx`
- `research/i18n/bag-art/email.zh-CN.json`
- `research/i18n/bag-art/email/5.png`
- `research/i18n/bag-art/email/54.png`
- `research/i18n/tooltip-quest-art/smooth-labels.zh-CN.json`
- `research/i18n/zh-CN-item-names.json`
- `research/i18n/zh-CN-pve-overrides.json`
- `research/i18n/zh-CN-server-additions.json`
- `research/i18n/zh-CN-server-row-overrides.json`
- `research/i18n/zh-CN-template-text.json`
- `scripts/workshop-bag-art.mjs`
- `scripts/workshop-battle-music.test.mjs`
- `scripts/workshop-client-chinese-coverage.test.mjs`
- `scripts/workshop-email-art.test.mjs`
- `scripts/workshop-literals.mjs`
- `scripts/workshop-smith-gift-price.test.mjs`
- `scripts/workshop-tooltip-labels.mjs`
- `scripts/workshop-tooltip-labels.test.mjs`
- `scripts/workshop-weapon-audio.test.mjs`
- `scripts/workshop-weapon-smith.ts`
- `scripts/workshop-weapon-visuals.test.ts`
- `scripts/workshop-weapon-visuals.ts`
- `tools/i18n/abc-strings/battle-music.mjs`
- `tools/i18n/abc-strings/smith-gift-price.mjs`
- `tools/i18n/abc-strings/weapon-audio.mjs`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/templates/defs.ts`：D05；branch_patch_present_with_additional_workspace_changes。
- `apps/game/HANDLERS.md`：D25；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/db/templates.ts`：D06；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/game/events.ts`：D07；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/events.ts`：D08；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/forge.ts`：D09；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/handlers/items.ts`：D26；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/pets.ts`：D10；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/rooms.ts`：D01；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/use.ts`：D11；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/server.ts`：D12；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/session/login.ts`：D13；branch_patch_present_with_additional_workspace_changes。
- `apps/web/src/pages/Play.tsx`：D02；branch_patch_present_with_additional_workspace_changes。
- `docs/workshop.zh-CN.md`：D14；branch_patch_present_with_additional_workspace_changes。
- `packages/db/src/translations.ts`：D15；superseded_by_exact_other_branch_result。
- `packages/db/test/template-text.test.ts`：D16；superseded_by_exact_other_branch_result。
- `packages/fight/src/game/equipEffects.ts`：D17；branch_patch_present_with_additional_workspace_changes。
- `packages/fight/src/game/game.ts`：D27；branch_patch_present_with_additional_workspace_changes。
- `research/i18n/zh-CN-overrides.json`：D18；superseded_by_exact_other_branch_result。
- `research/i18n/zh-CN-server-overrides.json`：D19；branch_records_preserved_with_additions。
- `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as`：D21；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.mjs`：D22；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.test.mjs`：D23；superseded_by_exact_other_branch_result。

### codex/smith-battle-music

头 `1d091e54526429526c0359835606122e10fafb36`；共同基点 `10a9165d5a14f7693a89e62a4788b44132c20a79`。

共同基点之后提交（可能被其它分支继承）：

- `edabd1a81a47` fix(workshop): expose activity tasks and translate room feedback；改动4文件；其它分支也包含此提交。
- `cb9f57e2643d` Translate core login and battle feedback into Chinese；改动1文件；其它分支也包含此提交。
- `1d431f768290` Localize runtime battle effect and insufficient-money messages；改动4文件；其它分支也包含此提交。
- `40aa5ac255be` fix(i18n): clarify cave materials and footer rules；改动3文件；其它分支也包含此提交。
- `c7628498c0d5` fix(i18n): translate the native flight prop tooltip；改动2文件；其它分支也包含此提交。
- `7755f786cfc0` fix(i18n): translate the native extra attack tooltip；改动2文件；其它分支也包含此提交。
- `ec6c76c4722d` fix(i18n): complete native battle toolbar prop text；改动2文件；其它分支也包含此提交。
- `f56f10dd7f33` fix(i18n): translate activity potion names and experience feedback；改动3文件；其它分支也包含此提交。
- `cf533e622fc9` fix(i18n): translate common activity material descriptions；改动2文件；其它分支也包含此提交。
- `8746f0c64956` fix(i18n): translate cumulative sign reward materials；改动2文件；其它分支也包含此提交。
- `458e5b1d4a12` fix(i18n): translate mail and item-use feedback；改动1文件；其它分支也包含此提交。
- `77aa846ff6e6` fix(i18n): translate pet feeding feedback；改动1文件；其它分支也包含此提交。
- `6145758a85b8` fix(i18n): translate original email window captions；改动5文件；其它分支也包含此提交。
- `a5f0c08501d6` fix(i18n): localize claim feedback and verify battle reward persistence；改动5文件；其它分支也包含此提交。
- `fff12cebde49` fix(events): reject unconfigured first recharge gifts before claiming；改动7文件；其它分支也包含此提交。
- `d073d9264501` fix(i18n): translate displayed game content and interface into Chinese；改动92文件；其它分支也包含此提交。
- `1d091e545264` Fix imported weapon smith access and battle music transitions；改动8文件；其它分支也包含此提交。

内容已覆盖文件：

- `apps/admin/src/crud/FieldInput.tsx`
- `apps/admin/src/crud/schema.ts`
- `apps/admin/src/mocks/db.ts`
- `apps/admin/src/mocks/handlers.ts`
- `apps/admin/src/pages/Dashboard.tsx`
- `apps/admin/src/pages/Events.tsx`
- `apps/admin/src/pages/Mail.tsx`
- `apps/admin/src/pages/ServerConfig.tsx`
- `apps/admin/src/resources/content.ts`
- `apps/admin/src/resources/event-systems.ts`
- `apps/admin/src/resources/guilds.ts`
- `apps/admin/src/resources/items.ts`
- `apps/admin/src/resources/players.ts`
- `apps/admin/src/resources/system.tsx`
- `apps/admin/test/api-chinese-errors.test.ts`
- `apps/admin/test/i18n.test.ts`
- `apps/api/src/routes/admin-resources.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/test/chinese-display-overlay.test.ts`
- `apps/api/test/item-name-overlay.test.ts`
- `apps/api/test/template-text-overlay.test.ts`
- `apps/game/src/db/consortia.ts`
- `apps/game/src/game/cards.ts`
- `apps/game/src/game/consortia-mgr.ts`
- `apps/game/src/game/consortia.ts`
- `apps/game/src/game/world-boss-rewards.ts`
- `apps/game/src/handlers/academy.ts`
- `apps/game/src/handlers/activities.ts`
- `apps/game/src/handlers/auction.ts`
- `apps/game/src/handlers/basic.ts`
- `apps/game/src/handlers/consortia.ts`
- `apps/game/src/handlers/farm.ts`
- `apps/game/src/handlers/hotspring.ts`
- `apps/game/src/handlers/mail.ts`
- `apps/game/src/handlers/marriage.ts`
- `apps/game/test/events-feedback.test.ts`
- `apps/game/test/fight.test.ts`
- `apps/game/test/first-recharge-config.test.ts`
- `apps/game/test/first-recharge-login.test.ts`
- `apps/web/index.html`
- `apps/web/src/components/GameFrame.tsx`
- `apps/web/src/components/SiteLayout.tsx`
- `apps/web/src/mocks/handlers.ts`
- `apps/web/src/pages/Play.native-menu.test.tsx`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTAH1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTK1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1123.ts`
- `packages/fight/src/pve/scripts/generated/Messions/BLTTT1124.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GAH1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GK1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/GT1076.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KD1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/KT1121.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAEpic13402.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAH13202.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAN13102.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAS13002.ts`
- `packages/fight/src/pve/scripts/generated/Messions/WAT13302.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhHardLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhNormalLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/SeventhSimpleLongNpc.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirdNormalBloomNpcS2.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenHardBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenNormalBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenSimpleBrynBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorAntBoss.ts`
- `packages/fight/src/pve/scripts/generated/NPC/ThirteenTerrorBrynBoss.ts`
- `packages/fight/test/equip-language.test.ts`
- `packages/ui/src/api.ts`
- `packages/ui/src/components/dialog.tsx`
- `packages/ui/src/components/misc.tsx`
- `packages/ui/src/i18n.tsx`
- `research/i18n/bag-art/email.zh-CN.json`
- `research/i18n/bag-art/email/5.png`
- `research/i18n/bag-art/email/54.png`
- `research/i18n/zh-CN-item-names.json`
- `research/i18n/zh-CN-pve-overrides.json`
- `research/i18n/zh-CN-server-additions.json`
- `research/i18n/zh-CN-server-row-overrides.json`
- `scripts/workshop-bag-art.mjs`
- `scripts/workshop-battle-music.test.mjs`
- `scripts/workshop-client-chinese-coverage.test.mjs`
- `scripts/workshop-email-art.test.mjs`
- `scripts/workshop-weapon-audio.test.mjs`
- `scripts/workshop-weapon-smith.ts`
- `scripts/workshop-weapon-visuals.test.ts`
- `scripts/workshop-weapon-visuals.ts`
- `tools/i18n/abc-strings/battle-music.mjs`
- `tools/i18n/abc-strings/weapon-audio.mjs`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/templates/defs.ts`：D05；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/db/templates.ts`：D06；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/game/events.ts`：D07；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/events.ts`：D08；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/forge.ts`：D09；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/handlers/pets.ts`：D10；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/rooms.ts`：D01；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/handlers/use.ts`：D11；overlapping_later_changes_review_before_marking_integrated。
- `apps/game/src/server.ts`：D12；branch_patch_present_with_additional_workspace_changes。
- `apps/game/src/session/login.ts`：D13；branch_patch_present_with_additional_workspace_changes。
- `apps/web/src/pages/Play.tsx`：D02；branch_patch_present_with_additional_workspace_changes。
- `docs/workshop.zh-CN.md`：D14；branch_patch_present_with_additional_workspace_changes。
- `packages/db/src/translations.ts`：D15；superseded_by_exact_other_branch_result。
- `packages/db/test/template-text.test.ts`：D16；superseded_by_exact_other_branch_result。
- `packages/fight/src/game/equipEffects.ts`：D17；branch_patch_present_with_additional_workspace_changes。
- `research/i18n/zh-CN-overrides.json`：D18；superseded_by_exact_other_branch_result。
- `research/i18n/zh-CN-server-overrides.json`：D19；branch_records_preserved_with_additions。
- `research/i18n/zh-CN-template-text.json`：D20；branch_patch_present_with_additional_workspace_changes。
- `scripts/native-caveloot/WorkshopNativeCaveLootBootstrap.as`：D21；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.mjs`：D22；branch_patch_present_with_additional_workspace_changes。
- `scripts/workshop-language.test.mjs`：D23；superseded_by_exact_other_branch_result。
- `scripts/workshop-literals.mjs`：D31；superseded_by_exact_other_branch_result。

### codex/treasure-cardbox-use

头 `0956734734f170ad16e8ba206f6409c67e6607e8`；共同基点 `1585d30c1ea3ff0134b72724fd0c9770fb8342dd`。

共同基点之后提交（可能被其它分支继承）：

- `0acaf985984b` feat(treasure): admit verified necklace rewards and preserve issued prizes；改动5文件；其它分支也包含此提交。
- `0956734734f1` feat(treasure): admit verified card boxes with locked original dependencies；改动6文件；其它分支也包含此提交。

内容已覆盖文件：

- `apps/api/src/activities/service.ts`
- `apps/api/test/fixtures/treasure-cardbox.json`
- `apps/api/test/fixtures/treasure-necklace.json`
- `apps/api/test/treasure-cardbox-integration.test.ts`
- `apps/api/test/treasure-necklace-integration.test.ts`
- `apps/game/test/treasure-cardbox-use.test.ts`
- `apps/game/test/treasure-necklace-use.test.ts`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/activities/treasure-catalog.ts`：D32；superseded_by_exact_other_branch_result。
- `apps/api/test/treasure-native.test.ts`：D33；superseded_by_exact_other_branch_result。

### codex/treasure-jewelry-use

头 `08fcf3f89ea0d74b1e39895e18c6f7292f34054c`；共同基点 `1585d30c1ea3ff0134b72724fd0c9770fb8342dd`。

共同基点之后提交（可能被其它分支继承）：

- `0acaf985984b` feat(treasure): admit verified necklace rewards and preserve issued prizes；改动5文件；其它分支也包含此提交。
- `0956734734f1` feat(treasure): admit verified card boxes with locked original dependencies；改动6文件；其它分支也包含此提交。
- `08fcf3f89ea0` feat(treasure): admit verified suitless jewelry with durable equip coverage；改动5文件；其它分支也包含此提交。

内容已覆盖文件：

- `apps/api/src/activities/service.ts`
- `apps/api/test/fixtures/treasure-cardbox.json`
- `apps/api/test/fixtures/treasure-jewelry.json`
- `apps/api/test/fixtures/treasure-necklace.json`
- `apps/api/test/treasure-cardbox-integration.test.ts`
- `apps/api/test/treasure-jewelry-integration.test.ts`
- `apps/api/test/treasure-necklace-integration.test.ts`
- `apps/game/test/treasure-cardbox-use.test.ts`
- `apps/game/test/treasure-jewelry-use.test.ts`
- `apps/game/test/treasure-necklace-use.test.ts`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/activities/treasure-catalog.ts`：D34；superseded_by_exact_other_branch_result。
- `apps/api/test/treasure-native.test.ts`：D35；superseded_by_exact_other_branch_result。

### codex/treasure-necklace-use

头 `0acaf985984bf9910d634a471d528a4d19c9e0e4`；共同基点 `1585d30c1ea3ff0134b72724fd0c9770fb8342dd`。

共同基点之后提交（可能被其它分支继承）：

- `0acaf985984b` feat(treasure): admit verified necklace rewards and preserve issued prizes；改动5文件；其它分支也包含此提交。

内容已覆盖文件：

- `apps/api/test/fixtures/treasure-necklace.json`
- `apps/api/test/treasure-necklace-integration.test.ts`
- `apps/game/test/treasure-necklace-use.test.ts`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/activities/treasure-catalog.ts`：D36；superseded_by_exact_other_branch_result。
- `apps/api/test/treasure-native.test.ts`：D37；superseded_by_exact_other_branch_result。

### codex/treasure-petfood-admission

头 `3dee8ed492cd772eca5e59a65eded8ea9b4bec1c`；共同基点 `1585d30c1ea3ff0134b72724fd0c9770fb8342dd`。

共同基点之后提交（可能被其它分支继承）：

- `0acaf985984b` feat(treasure): admit verified necklace rewards and preserve issued prizes；改动5文件；其它分支也包含此提交。
- `0956734734f1` feat(treasure): admit verified card boxes with locked original dependencies；改动6文件；其它分支也包含此提交。
- `08fcf3f89ea0` feat(treasure): admit verified suitless jewelry with durable equip coverage；改动5文件；其它分支也包含此提交。
- `0264422ca4cd` fix(pets): save feeding and food consumption atomically；改动3文件；其它分支也包含此提交。
- `3dee8ed492cd` fix(treasure): admit verified high-grade pet food；改动3文件；本地列举分支中独占提交。

内容已覆盖文件：

- `apps/api/src/activities/service.ts`
- `apps/api/src/activities/treasure-catalog.ts`
- `apps/api/test/fixtures/treasure-cardbox.json`
- `apps/api/test/fixtures/treasure-jewelry.json`
- `apps/api/test/fixtures/treasure-necklace.json`
- `apps/api/test/treasure-cardbox-integration.test.ts`
- `apps/api/test/treasure-jewelry-integration.test.ts`
- `apps/api/test/treasure-native.test.ts`
- `apps/api/test/treasure-necklace-integration.test.ts`
- `apps/api/test/treasure-petfood-integration.test.ts`
- `apps/game/src/game/player-transaction.ts`
- `apps/game/test/treasure-cardbox-use.test.ts`
- `apps/game/test/treasure-jewelry-use.test.ts`
- `apps/game/test/treasure-necklace-use.test.ts`
- `apps/game/test/treasure-petfood-use.test.ts`

内容不一致文件（详细摘要见上表）：

- `apps/game/src/handlers/pets.ts`：D38；branch_patch_present_with_additional_workspace_changes。

### codex/treasure-petfood-use

头 `0264422ca4cdcfa3c9c022056ca25472428a1621`；共同基点 `1585d30c1ea3ff0134b72724fd0c9770fb8342dd`。

共同基点之后提交（可能被其它分支继承）：

- `0acaf985984b` feat(treasure): admit verified necklace rewards and preserve issued prizes；改动5文件；其它分支也包含此提交。
- `0956734734f1` feat(treasure): admit verified card boxes with locked original dependencies；改动6文件；其它分支也包含此提交。
- `08fcf3f89ea0` feat(treasure): admit verified suitless jewelry with durable equip coverage；改动5文件；其它分支也包含此提交。
- `0264422ca4cd` fix(pets): save feeding and food consumption atomically；改动3文件；其它分支也包含此提交。

内容已覆盖文件：

- `apps/api/src/activities/service.ts`
- `apps/api/test/fixtures/treasure-cardbox.json`
- `apps/api/test/fixtures/treasure-jewelry.json`
- `apps/api/test/fixtures/treasure-necklace.json`
- `apps/api/test/treasure-cardbox-integration.test.ts`
- `apps/api/test/treasure-jewelry-integration.test.ts`
- `apps/api/test/treasure-necklace-integration.test.ts`
- `apps/game/src/game/player-transaction.ts`
- `apps/game/test/treasure-cardbox-use.test.ts`
- `apps/game/test/treasure-jewelry-use.test.ts`
- `apps/game/test/treasure-necklace-use.test.ts`
- `apps/game/test/treasure-petfood-use.test.ts`

内容不一致文件（详细摘要见上表）：

- `apps/api/src/activities/treasure-catalog.ts`：D34；superseded_by_exact_other_branch_result。
- `apps/api/test/treasure-native.test.ts`：D35；superseded_by_exact_other_branch_result。
- `apps/game/src/handlers/pets.ts`：D38；branch_patch_present_with_additional_workspace_changes。

## 剩余边界

保留工作区是防止撤销后续组合改动的建议，不代表本次运行了相关测试。逐文件哈希、LFS指针、逐提交文件列表、补丁只读检查结果和变更行范围见 `branch-ledger.json`。存在后续重叠的owner需由主控主题提交和全套测试闭环；无需先整支合并来“补齐”。

## 冻结后漂移补充

最终复核的8个 Thirteen*AntBoss/BrynBoss 文件已单独比对：均仅移除了第17行末尾两个空格；字符串、代码和行数保持。原冻结台账未回写为新快照；具体旧/新哈希见 `snapshot-drift-review.json`。此说明不是本代理修改了文件。
