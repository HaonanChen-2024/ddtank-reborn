# 生成入口逐项审查

原74入口的91个字面import闭包文件已逐个只读检查；另外补10个早期真实来源入口。未执行这些旧入口。

| 文件 | 处理 | 原因 |
|---|---|---|
| `runtime/email-remaining-zh-20261017/build-exact-candidate.mjs` | do-not-migrate-whole-file | 旧邮件同尺寸供体替换阶段；固定候选目录和回执I/O不迁，实际tag替换逻辑由swf-image-builder及fixed recipe复现。 |
| `runtime/email-remaining-zh-20261017/build-final-candidate.mjs` | do-not-migrate-whole-file | 邮件最终contain适配和精确供体阶段；生成逻辑已提取为swf-image-builder，输入改固定原素材包，旧候选路径不作输入。 |
| `runtime/feedback-forge-20261017/build-bitmaps.mjs` | do-not-migrate-whole-file | 铁匠铺原供体/生成PNG与tag组装混在日期目录入口，需先为三个SWF梳理完整复合顺序；本批不迁且未声称可重建铁匠铺。 |
| `runtime/feedback-forge-20261017/build-text.mjs` | do-not-migrate-whole-file | 铁匠铺FFDec文本编译入口依赖日期目录inspect/格式化源及字体前置，须改参数和原始输入后单独验证；本批未执行。 |
| `runtime/feedback-forge-20261017/inspect.mjs` | do-not-migrate-whole-file | 提供文本解析与审查数据，属于分析辅助；当前4纯模块不依赖此文件，不为重建复制它及其扫描入口。 |
| `runtime/feedback-forge-20261017/patch-pure-chinese.mjs` | do-not-migrate-whole-file | forge后续文字和图片复合补丁阶段，不是原版到现役独立入口；仍缺已固定的完整前置链。 |
| `runtime/feedback-forge-20261017/patch-semantic.mjs` | do-not-migrate-whole-file | forge语义纠正的后续补丁；保留来源但不绕过前置tag/SWF pin，不直接迁移日期入口。 |
| `runtime/feedback-remaining-20261017/static-text/build.mjs` | do-not-migrate-whole-file | 字体载体、文本排版与最小tag合并已提取为static-text-builder；CLI扫描、日期路径、渲染/候选I/O不迁。 |
| `runtime/feedback-remaining-20261017/static-text/font-layout.mjs` | do-not-migrate-whole-file | 字形度量纯逻辑已提取为font-layout-pure，并由调用方注入canvas context；原文件依赖解析路径不迁。 |
| `runtime/feedback-remaining-20261017/static-text/inventory.mjs` | do-not-migrate-whole-file | 静态文字盘点入口和扫描结果依赖；不参与本批确定性产物生成，不迁。 |
| `runtime/feedback-room-20261017/build-loading-text.mjs` | do-not-migrate-whole-file | room加载文字前置与FFDec流程已由static-text-builder/extended CLI实现，旧目录入口不迁。 |
| `runtime/feedback-room-20261017/build.mjs` | do-not-migrate-whole-file | room/roomlist图像组装已提取为swf-image-builder，sourceId与尺寸/三态/精确tag pins转为固定recipe；不迁旧生成图复制和审查输出入口。 |
| `runtime/feedback-room-20261017/finish-loading-text.mjs` | do-not-migrate-whole-file | 最小font/text tag回合并已提取为finishStaticText；旧compiled输出不能成为新重建输入。 |
| `runtime/hall-tutorial-zh-20261017/build-candidate.mjs` | do-not-migrate-whole-file | hall/tutorial图像和文本复合阶段仍依赖历史前置基底与多个后续图像/文字合并；本批无完整逐字节重建证明。 |
| `runtime/hall-tutorial-zh-20261017/merge-generated-word-rois.mjs` | do-not-migrate-whole-file | 审核后生成文字ROI的机械合并阶段；需要原图、生成图和ROI记录归档后才能迁成参数化纯函数，不能复制其候选成品。 |
| `runtime/pure-zh-gameover-20261016/build-candidate.mjs` | do-not-migrate-whole-file | gameover位图批次依赖审定图像及旧补丁前置；未纳入本批固定原素材包，因此仍为逐文件例外。 |
| `runtime/remaining-image-surfaces-20261017/build-candidates.mjs` | do-not-migrate-whole-file | 多包图像/静态内容批处理入口写日期目录并读历史候选；当前输入/顺序尚未逐包固定，不整文件迁。 |
| `runtime/remaining-image-surfaces-20261017/inspect.mjs` | do-not-migrate-whole-file | SWF分析函数与盘点入口混合，不是产物生成器；当前纯模块改复用repo lib避免导入扫描副作用。 |
| `runtime/shop-pure-zh-20261016/build.mjs` | do-not-migrate-whole-file | 商城99图入口依赖审定生成图、基底与日期目录回执，尚未迁出全部原素材及纯参数接口；本批仍为例外。 |
| `source/ddtank-reborn/scripts/native-carnival/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-carnival/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-caveloot/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-caveloot/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-charge/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-charge/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-christmas/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-christmas/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-christmas/patch-battle-return.mjs` | already-in-repo-support-module | 现有活动分析/局部补丁辅助，不是独立完整生成入口；已随repo保留，当前无需复制或执行。 |
| `source/ddtank-reborn/scripts/native-ddplay/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-ddplay/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-devil/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-devil/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-exchange/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-exchange/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-first-recharge/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-first-recharge/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-forthright/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-forthright/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-gypsy/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-gypsy/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-menu/build-original-art.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-mines-extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-mines/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-moonlight/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-moonlight/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-pair/audit-candidate.mjs` | already-in-repo-support-module | 现有活动分析/局部补丁辅助，不是独立完整生成入口；已随repo保留，当前无需复制或执行。 |
| `source/ddtank-reborn/scripts/native-pair/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-pair/build-shared-art.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-purr/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-purr/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/native-shared/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-treasure/build-library.mjs` | already-in-repo-not-executed | 原owner适配库生成源码已在repo；调用方可传out，但源core或组件原件仍由内部路径决定。保留此行为所有者，先迁固定数据接口，不复制现成library SWF。 |
| `source/ddtank-reborn/scripts/native-treasure/extract-resources.mjs` | already-in-repo-not-executed | 活动原件解析/提取源码已在repo；依赖参考服输入和共享UI/art pins。输出参数不等于来源根可移植，literalRuntimeInputs为本文件可见缺口，暂不纳入严格构建。 |
| `source/ddtank-reborn/scripts/workshop-activity-entry.mjs` | already-in-repo-not-executed | 生成/布局/入口行为所有者已在repo，无需迁移；未进入当前7项安全适配器的后续复合步骤仍须固定其输入、纯API和顺序。见逐文件导出函数、调用点和历史输入路径。 |
| `source/ddtank-reborn/scripts/workshop-bag-art.mjs` | already-in-repo-pure-api-used | 已在repo；当前安全CLI仅调用显式纯API，不复制、不运行原安装/主入口。已用于7项严格重建。 |
| `source/ddtank-reborn/scripts/workshop-bag-layout.mjs` | already-in-repo-pure-api-used | 已在repo；当前安全CLI仅调用显式纯API，不复制、不运行原安装/主入口。已用于7项严格重建。 |
| `source/ddtank-reborn/scripts/workshop-calendar-art.mjs` | already-in-repo-pure-api-used | 已在repo；当前安全CLI仅调用显式纯API，不复制、不运行原安装/主入口。已用于7项严格重建。 |
| `source/ddtank-reborn/scripts/workshop-game-energy-text.mjs` | already-in-repo-not-executed | 生成/布局/入口行为所有者已在repo，无需迁移；未进入当前7项安全适配器的后续复合步骤仍须固定其输入、纯API和顺序。见逐文件导出函数、调用点和历史输入路径。 |
| `source/ddtank-reborn/scripts/workshop-hall-hover.mjs` | already-in-repo-not-executed | 生成/布局/入口行为所有者已在repo，无需迁移；未进入当前7项安全适配器的后续复合步骤仍须固定其输入、纯API和顺序。见逐文件导出函数、调用点和历史输入路径。 |
| `source/ddtank-reborn/scripts/workshop-language.mjs` | already-in-repo-not-executed | 生成/布局/入口行为所有者已在repo，无需迁移；未进入当前7项安全适配器的后续复合步骤仍须固定其输入、纯API和顺序。见逐文件导出函数、调用点和历史输入路径。 |
| `source/ddtank-reborn/scripts/workshop-literals.mjs` | already-in-repo-not-executed | 生成/布局/入口行为所有者已在repo，无需迁移；未进入当前7项安全适配器的后续复合步骤仍须固定其输入、纯API和顺序。见逐文件导出函数、调用点和历史输入路径。 |
| `source/ddtank-reborn/scripts/workshop-native-carnival.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-caveloot.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-charge.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-christmas.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-ddplay.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-devil.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-exchange.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-first-recharge.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-forthright.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-gypsy.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-mines.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-moonlight.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-pair.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-purr.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-treasure.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-wardrobe-entry.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-native-wardrobe.mjs` | already-in-repo-not-executed | 活动编排源码已在repo，不需要迁移。通常支持outputDir，但输入与编译器/参考core/组件目录仍绑定历史路径；按affectedOverlayFiles和literalRuntimeInputs逐项固定后才能加入安全CLI，当前不执行。 |
| `source/ddtank-reborn/scripts/workshop-original-ui-bitmaps.mjs` | already-in-repo-not-executed | 生成/布局/入口行为所有者已在repo，无需迁移；未进入当前7项安全适配器的后续复合步骤仍须固定其输入、纯API和顺序。见逐文件导出函数、调用点和历史输入路径。 |
| `source/ddtank-reborn/scripts/workshop-tooltip-labels.mjs` | already-in-repo-not-executed | 生成/布局/入口行为所有者已在repo，无需迁移；未进入当前7项安全适配器的后续复合步骤仍须固定其输入、纯API和顺序。见逐文件导出函数、调用点和历史输入路径。 |
| `source/ddtank-reborn/scripts/workshop-tooltip-quest-art.mjs` | already-in-repo-not-executed | 生成/布局/入口行为所有者已在repo，无需迁移；未进入当前7项安全适配器的后续复合步骤仍须固定其输入、纯API和顺序。见逐文件导出函数、调用点和历史输入路径。 |
| `source/ddtank-reborn/scripts/workshop-weapon-audio-assets.mjs` | already-in-repo-not-executed | 生成/布局/入口行为所有者已在repo，无需迁移；未进入当前7项安全适配器的后续复合步骤仍须固定其输入、纯API和顺序。见逐文件导出函数、调用点和历史输入路径。 |
| `source/ddtank-reborn/tools/i18n/abc-strings/activity-response.mjs` | already-in-repo-support-module | 已在repo的ABC解析/变换支持模块。按imports列由行为所有者调用，无需再迁一份；当前未据此单独执行历史复合客户端补丁。 |
| `source/ddtank-reborn/tools/i18n/abc-strings/activity-state.mjs` | already-in-repo-support-module | 已在repo的ABC解析/变换支持模块。按imports列由行为所有者调用，无需再迁一份；当前未据此单独执行历史复合客户端补丁。 |
| `source/ddtank-reborn/tools/i18n/abc-strings/battle-music.mjs` | already-in-repo-support-module | 已在repo的ABC解析/变换支持模块。按imports列由行为所有者调用，无需再迁一份；当前未据此单独执行历史复合客户端补丁。 |
| `source/ddtank-reborn/tools/i18n/abc-strings/crater-mask.mjs` | already-in-repo-support-module | 已在repo的ABC解析/变换支持模块。按imports列由行为所有者调用，无需再迁一份；当前未据此单独执行历史复合客户端补丁。 |
| `source/ddtank-reborn/tools/i18n/abc-strings/exchange-state.mjs` | already-in-repo-support-module | 已在repo的ABC解析/变换支持模块。按imports列由行为所有者调用，无需再迁一份；当前未据此单独执行历史复合客户端补丁。 |
| `source/ddtank-reborn/tools/i18n/abc-strings/lib.mjs` | already-in-repo-pure-api-used | 已在repo；当前安全CLI仅调用显式纯API，不复制、不运行原安装/主入口。已用于7项严格重建。 |
| `source/ddtank-reborn/tools/i18n/abc-strings/patch.mjs` | already-in-repo-support-module | 已在repo的ABC解析/变换支持模块。按imports列由行为所有者调用，无需再迁一份；当前未据此单独执行历史复合客户端补丁。 |
| `source/ddtank-reborn/tools/i18n/abc-strings/smith-gift-price.mjs` | already-in-repo-support-module | 已在repo的ABC解析/变换支持模块。按imports列由行为所有者调用，无需再迁一份；当前未据此单独执行历史复合客户端补丁。 |
| `source/ddtank-reborn/tools/i18n/abc-strings/weapon-audio.mjs` | already-in-repo-support-module | 已在repo的ABC解析/变换支持模块。按imports列由行为所有者调用，无需再迁一份；当前未据此单独执行历史复合客户端补丁。 |
| `runtime/online-box-followup-20261013/toolbar-ui-prep/build.mjs` | historical-additional-owner | hardcoded output and runtime config; extract patch/paint only, do not carry build/install/probe main |
| `runtime/online-box-followup-20261013/toolbar-ui-prep/jpeg3.mjs` | historical-additional-owner | has project-relative runtime tool/config initialization; parameterize before migration |
| `runtime/online-box-followup-20261013/toolbar-ui-prep/paint.mjs` | historical-additional-owner | has project-relative runtime tool/config initialization; parameterize before migration |
| `runtime/online-box-followup-20261013/toolbar-ui-prep/decode-raster.py` | historical-additional-owner | small stdin/stdout Pillow decoder; can migrate separately after dependency/version pin |
| `runtime/online-box-followup-20261013/hall-ui-chinese-refine/build.mjs` | historical-additional-owner | hardcoded output and runtime config; extract patch/paint only, do not carry build/install/probe main |
| `runtime/online-box-followup-20261013/hall-ui-chinese-refine/paint.mjs` | historical-additional-owner | has project-relative runtime tool/config initialization; parameterize before migration |
| `runtime/online-box-followup-20261013/ui-next-20261013/prepare-event-compatible.mjs` | historical-additional-owner | mixes actual Ruffle capture, generated probe/renderer and candidate I/O; extract only tag197 pixel composition |
| `runtime/room-pure-zh-20261016/prepare.mjs` | historical-additional-owner | writes current research assets/config; extract only renderer, retain recipe and fonts |
| `runtime/email-ui-zh-20261016/stamp-prepare.mjs` | historical-additional-owner | writes current research assets/config; extract only renderer, retain recipe and fonts |
| `runtime/email-ui-zh-20261016/prepare-controls.mjs` | historical-additional-owner | writes current research assets/config; extract only renderer, retain recipe and fonts |

完整导出函数、显式输出参数、CLI guard、FS/子进程调用行、字面历史路径、关联产物和AS清单见 entry-audit.json。FS调用点并不自动等于顶层副作用；此表没有把静态扫描冒充实际执行验证。
