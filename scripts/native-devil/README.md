# 原恶魔宝藏离线窗口候选

`workshop-native-devil.mjs` 保留原40个业务/UI owner，并把真实缺失的 `ConfirmAlertData`、`QuickBuyAlertBase` 两个支援 owner 精确隔离到 `workshop.devil.original.host`。业务 QName 与布局运行名称统一隔离，原11份 XML、原 art SWF 不变。外部14个原位图标签（含滚动条三状态）以独立别名进入 library；未知的 `asset.ddtshop.BuyBtn` 明确使用已缓存 `asset.ui.btn_yellow1` 替代，不宣称找到了原图。

保留的流程包括原八格转盘、五珠兑换三箱、五阶段双骰、九档累计探险礼和带原数量器的四项印记商城。原转盘 `DevilTurnControl` 的加速、匀速、减速 Timer 及 `complete` 事件保持；原骰子 `Timer(800,2)`、右骰阶段、最终骰面 `+6` 和总点数显示方法保持。具体两个骰面只读服务端结果，移除原随机拆分。GET、UUID replay 和重新打开仅静态还原，恢复已有骰局不再次消耗宝箱。

本地规则以冻结 `native-devil-contract-b.ts` 为准：每天免费一次，20活动积分买一次、200积分买十次，一次请求最多10抽；材料永久绑定并寄邮件。珠、箱和印记是活动账本计数，不伪造物品模板。双骰阶段、重试10积分、九档累计次数礼及四种普通材料配方均由本地 API 权威返回。原全服奖池、排名、时限箱与私服经济规则未接入，运行布局明确显示本地规则。

83个原方法定向转入本地适配。四个原付款匿名回调由所替换父方法的实际 `newfunction` 引用递归定位，若意外调用会显式拒绝；不会加载空付款 helper。其余262个 method body 保持原字节，审计额外固定28个原方法。原结果窗自动2000毫秒关闭和 `closeCall()` 双回调已断开，结果窗关闭不会自动再次POST。HTTP与UUID由既有页面 ledger 持有；原转盘结束前和结果窗确认前保留独立 busy 锁。

关闭停止原转盘声音/Timer、双骰Timer、免费/奖池Timer，解绑 owned 监听、数量器和确认窗，清理子窗及共享场景根。关闭后的POST仍由页面保存原UUID回执，迟到响应不会重新创建窗口。原角色、代次、序列、版本及完整54字符状态令牌持续校验。

四个运行资源位于 `/flash/workshop-native/devil/`：

- `WorkshopNativeDevilBootstrap.swf`
- `devil-original-library.swf`
- `devilturn_v3_6_1_u1.swf`
- `devilturn.ui`

五个 compiler 源为根 builder 与本目录的 Bootstrap、library builder、extractor、audit；README另计。依赖既有唯一82ABC共享域，五个模块回调沿用 `workshopDevilAcceptSnapshot/RejectRequest/OpenNative/CloseNative/StatusNative`；出站为 `workshopDevilRead/Request/Report`。联合包由主控制器维护，此模块不部署。

构建与审计只证明编译、原字节/闭包、宿主类和回调边界；实际 AVM2 首开、中文字体/位置、滚动、原转盘和双骰完整周期、关闭迟回/角色切换及真实邮件领取仍待运行验收。不得把离线通过称为游戏界面已验收。
