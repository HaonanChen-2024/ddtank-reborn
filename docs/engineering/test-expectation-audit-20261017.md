说明：下文为改动前的逐项审计快照；随后按这些结论更新了3个测试文件，最终验证见test-recovery-20261017.md。

# 19项文案期望逐项审计

依据用户直接要求“你们先把全部的语言变成纯中文”。这是中文显示目标授权，不冒称用户逐字批准每句译文；具体文本以已提交owner为准。本次只做审计，未改期望。

## E01 — uses the original-language fallback when the new unavailable key is missing

- 测试：`apps/game/test/first-recharge-config.test.ts`
- 旧期望：Presente indisponível no momento.
- 应接受：礼包暂不可用。
- owner：`apps/game/src/handlers/events.ts:594`；固化提交`53fc4fba`
- 中文意图与范围：缺新增语言key的首充不可用兜底有意改中文；不是把缺奖励配置伪装为成功。
- 后续最小文字调整：仅该fallback用例标题与expected字符串；保留重复拒绝、无claim、无库存/邮件变化的断言。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E02 — translates the real VIP box and duplicate without changing rewards or old mail (full=false)

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：VIP礼包领取成功。 {原奖励摘要}
- 应接受：贵宾礼包领取成功。 {相同奖励摘要}
- owner：`research/i18n/zh-CN-server-overrides.json:65`、`research/i18n/zh-CN-server-additions.json:5`、`apps/game/src/handlers/events.ts:403`；固化提交`eb18b11`
- 中文意图与范围：将自然语言VIP标签改为贵宾是纯中文目标的直接实施；物品数据字段与奖励列表不变。
- 后续最小文字调整：成功前缀改贵宾；后续重复提示改“今日贵宾礼包已领取。”；邮件标题改“每日贵宾礼包”；不删后续状态验证。
- 证据边界：日志中摘要部分仍有该隔离fixture未覆盖的越语道具名；expected与actual摘要完全相同。本轮只能证明外层提示有意改变，不据此声明整条消息已纯中文。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E03 — translates the real VIP box and duplicate without changing rewards or old mail (full=true)

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：VIP礼包领取成功。 {原奖励摘要}
- 应接受：贵宾礼包领取成功。 {相同奖励摘要}
- owner：`research/i18n/zh-CN-server-overrides.json:65`、`research/i18n/zh-CN-server-additions.json:5`、`apps/game/src/handlers/events.ts:403`；固化提交`eb18b11`
- 中文意图与范围：将自然语言VIP标签改为贵宾是纯中文目标的直接实施；物品数据字段与奖励列表不变。
- 后续最小文字调整：成功前缀改贵宾；后续重复提示改“今日贵宾礼包已领取。”；邮件标题改“每日贵宾礼包”；不删后续状态验证。
- 证据边界：日志中摘要部分仍有该隔离fixture未覆盖的越语道具名；expected与actual摘要完全相同。本轮只能证明外层提示有意改变，不据此声明整条消息已纯中文。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E04 — uses a truthful unavailable message for VIP level 0 and grants nothing

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：当前VIP礼包不可领取。
- 应接受：当前贵宾礼包不可领取。
- owner：`research/i18n/zh-CN-server-additions.json:4`、`apps/game/src/handlers/events.ts:392`；固化提交`eb18b11`
- 中文意图与范围：贵宾术语统一；等级0/99仍不得领取，不修改奖励或资格。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E05 — uses a truthful unavailable message for VIP level 99 and grants nothing

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：当前VIP礼包不可领取。
- 应接受：当前贵宾礼包不可领取。
- owner：`research/i18n/zh-CN-server-additions.json:4`、`apps/game/src/handlers/events.ts:392`；固化提交`eb18b11`
- 中文意图与范围：贵宾术语统一；等级0/99仍不得领取，不修改奖励或资格。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E06 — translates 6-day cumulative-sign rewards while retaining the no-90-reply contract (full=false)

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：累计签到奖励领取成功。 初级SUPER·古枪碎片 x2, 强化石5级 x2
- 应接受：累计签到奖励领取成功。 初级真·远古竹枪碎片 x2, 强化石5级 x2
- owner：`research/i18n/zh-CN-item-names.json (names.11041)`、`packages/db/src/translations.ts:164`、`apps/game/src/game/events.ts:249`；固化提交`eb18b11`
- 中文意图与范围：复用既有中文物品名overlay；不在测试修复中决定新译名，也不回退为含SUPER的旧文本。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E07 — translates 6-day cumulative-sign rewards while retaining the no-90-reply contract (full=true)

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：累计签到奖励领取成功。 初级SUPER·古枪碎片 x2, 强化石5级 x2
- 应接受：累计签到奖励领取成功。 初级真·远古竹枪碎片 x2, 强化石5级 x2
- owner：`research/i18n/zh-CN-item-names.json (names.11041)`、`packages/db/src/translations.ts:164`、`apps/game/src/game/events.ts:249`；固化提交`eb18b11`
- 中文意图与范围：复用既有中文物品名overlay；不在测试修复中决定新译名，也不回退为含SUPER的旧文本。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E08 — retains usable original-language fallbacks when the new overlay is absent

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：首个action要求前缀“Ovo diário recebido:”与标题“Ovo diário”；后续签到和missing等级礼包也固定葡语
- 应接受：首个action中文前缀“每日彩蛋领取成功：”与标题“每日彩蛋”；后续按具体key是否命中分支保留原词典或中文兜底
- owner：`apps/game/src/handlers/events.ts:386`、`apps/game/src/handlers/events.ts:387`、`apps/game/src/handlers/events.ts:445`、`apps/game/src/handlers/events.ts:468`、`apps/game/src/handlers/events.ts:518`；固化提交`53fc4fba`
- 中文意图与范围：没有新overlay时新增兜底也应可读中文；保持LanguageMgr返回命中的旧词典值，不机械改全部original分支。
- 后续最小文字调整：每日彩蛋title=每日彩蛋、prefix=每日彩蛋领取成功：；签到title=签到奖励、prefix=签到奖励领取成功！；等级礼包missing分支prefix=100级礼包领取成功。；original分支仍使用原词典“Presente de nível 100 recebido com sucesso”；VIP的既有original/missing前缀及Caixa VIP标题当前实现尚未改，保持当前分支契约；不把它们顺手当作本批翻译功能扩展。
- 证据边界：此次用例在首个action的startsWith断言停止；完整accepted序列由逐owner源码核对得出，待后续修复后实际执行全部actions。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E09 — retains usable missing-language fallbacks when the new overlay is absent

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：首个action要求前缀“Ovo diário recebido:”与标题“Ovo diário”；后续签到和missing等级礼包也固定葡语
- 应接受：首个action中文前缀“每日彩蛋领取成功：”与标题“每日彩蛋”；后续按具体key是否命中分支保留原词典或中文兜底
- owner：`apps/game/src/handlers/events.ts:386`、`apps/game/src/handlers/events.ts:387`、`apps/game/src/handlers/events.ts:445`、`apps/game/src/handlers/events.ts:468`、`apps/game/src/handlers/events.ts:518`；固化提交`53fc4fba`
- 中文意图与范围：没有新overlay时新增兜底也应可读中文；保持LanguageMgr返回命中的旧词典值，不机械改全部original分支。
- 后续最小文字调整：每日彩蛋title=每日彩蛋、prefix=每日彩蛋领取成功：；签到title=签到奖励、prefix=签到奖励领取成功！；等级礼包missing分支prefix=100级礼包领取成功。；original分支仍使用原词典“Presente de nível 100 recebido com sucesso”；VIP的既有original/missing前缀及Caixa VIP标题当前实现尚未改，保持当前分支契约；不把它们顺手当作本批翻译功能扩展。
- 证据边界：此次用例在首个action的startsWith断言停止；完整accepted序列由逐owner源码核对得出，待后续修复后实际执行全部actions。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E10 — uses precise original cumulative-sign rejection messages without adding a 90 response

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：四种原因分别要求旧葡语（首个InvalidTier即停止）
- 应接受：四种原因分别要求对应中文兜底
- owner：`apps/game/src/handlers/events.ts:459`、`apps/game/src/handlers/events.ts:461`、`apps/game/src/handlers/events.ts:462`、`apps/game/src/handlers/events.ts:460`；固化提交`53fc4fba`
- 中文意图与范围：新增key缺失时的可读兜底有意中文；不改变原词典已有key的命中机制。
- 后续最小文字调整：仅original/missing fallback表；Chinese使用additions中的既有中文措辞；保留四原因资格/claim/状态和无90包检查。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E11 — uses precise missing cumulative-sign rejection messages without adding a 90 response

- 测试：`apps/game/test/online-box-zh.test.ts`
- 旧期望：四种原因分别要求旧葡语（首个InvalidTier即停止）
- 应接受：四种原因分别要求对应中文兜底
- owner：`apps/game/src/handlers/events.ts:459`、`apps/game/src/handlers/events.ts:461`、`apps/game/src/handlers/events.ts:462`、`apps/game/src/handlers/events.ts:460`；固化提交`53fc4fba`
- 中文意图与范围：新增key缺失时的可读兜底有意中文；不改变原词典已有key的命中机制。
- 后续最小文字调整：仅original/missing fallback表；Chinese使用additions中的既有中文措辞；保留四原因资格/claim/状态和无90包检查。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E12 — sign award rejection notices reports unknown tier without changing rewards, claims or the original packet 90 contract

- 测试：`apps/game/test/sign-award-atomic.test.ts`
- 旧期望：Recompensa de presença indisponível.
- 应接受：该档签到奖励暂不可用。
- owner：`apps/game/src/handlers/events.ts:459`；固化提交`53fc4fba`
- 中文意图与范围：新增key缺失时的可读兜底有意中文；不改变原词典已有key的命中机制。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E13 — sign award rejection notices reports unreached tier without changing rewards, claims or the original packet 90 contract

- 测试：`apps/game/test/sign-award-atomic.test.ts`
- 旧期望：Dias de presença insuficientes para esta recompensa.
- 应接受：签到天数不足，无法领取该奖励。
- owner：`apps/game/src/handlers/events.ts:461`；固化提交`53fc4fba`
- 中文意图与范围：新增key缺失时的可读兜底有意中文；不改变原词典已有key的命中机制。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E14 — sign award rejection notices reports previous month without changing rewards, claims or the original packet 90 contract

- 测试：`apps/game/test/sign-award-atomic.test.ts`
- 旧期望：Dias de presença insuficientes para esta recompensa.
- 应接受：签到天数不足，无法领取该奖励。
- owner：`apps/game/src/handlers/events.ts:461`；固化提交`53fc4fba`
- 中文意图与范围：新增key缺失时的可读兜底有意中文；不改变原词典已有key的命中机制。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E15 — sign award rejection notices reports already claimed without changing rewards, claims or the original packet 90 contract

- 测试：`apps/game/test/sign-award-atomic.test.ts`
- 旧期望：Você já recebeu esta recompensa de presença neste mês.
- 应接受：你本月已领取该档签到奖励。
- owner：`apps/game/src/handlers/events.ts:462`；固化提交`53fc4fba`
- 中文意图与范围：新增key缺失时的可读兜底有意中文；不改变原词典已有key的命中机制。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E16 — sign award rejection notices rejects a sex-filtered empty reward tier without consuming its claim or reporting success

- 测试：`apps/game/test/sign-award-atomic.test.ts`
- 旧期望：Nenhuma recompensa de presença disponível para este personagem.
- 应接受：当前角色没有可领取的签到奖励。
- owner：`apps/game/src/handlers/events.ts:460`；固化提交`53fc4fba`
- 中文意图与范围：新增key缺失时的可读兜底有意中文；不改变原词典已有key的命中机制。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E17 — sign award rejection notices keeps rejection notices behind the owner transaction rollback and a later quit silent (quit=false)

- 测试：`apps/game/test/sign-award-atomic.test.ts`
- 旧期望：Recompensa de presença indisponível.
- 应接受：该档签到奖励暂不可用。
- owner：`apps/game/src/handlers/events.ts:459`；固化提交`53fc4fba`
- 中文意图与范围：新增key缺失时的可读兜底有意中文；不改变原词典已有key的命中机制。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E18 — sign award claim/rewards atomicity rolls back mail failure, including detached mail attachments and currencies; retry succeeds

- 测试：`apps/game/test/sign-award-atomic.test.ts`
- 旧期望：Prêmio de presença
- 应接受：签到奖励
- owner：`apps/game/src/handlers/events.ts:445`；固化提交`53fc4fba`
- 中文意图与范围：fixture lang仅返回key，邮件采用中文fallback；Type12、附件归属、失败回滚和重试成功保持。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## E19 — sign award claim/rewards atomicity grants exactly once for concurrent same-player/month/tier requests, without changing sex, binding or validity

- 测试：`apps/game/test/sign-award-atomic.test.ts`
- 旧期望：按葡语“Você já recebeu esta recompensa de presença neste mês.”过滤后计数7
- 应接受：按中文“你本月已领取该档签到奖励。”过滤后仍计数7
- owner：`apps/game/src/handlers/events.ts:462`；固化提交`53fc4fba`
- 中文意图与范围：新增key缺失时的可读兜底有意中文；不改变原词典已有key的命中机制。
- 后续最小文字调整：只改过滤匹配文本；保留8次并发恰好1次成功、1条claim、7条重复通知及精确奖励字段。
- 证据边界：本次第一条one-success及claim断言已通过，失败在旧文本过滤后的0≠7；后续奖励字段仍须修后回归。
- 必须保留奖励数值、资格、幂等、事务、存档/附件与协议包的原断言；不能直接删掉失败检查。

## 整体验收边界

19项逐条对应原始baseline失败，详见同名JSON。修复后仍需连续两次包级全量全绿，保留当前超时，不以禁用隔离、改变价格/奖励或只跑单文件代替。另一轮登录95成片超时目前未复现；师徒141已确认独立时区根因，不据此推论登录不稳定已被证伪。
