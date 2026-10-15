# 原充值大赠送：本地任务四页实验切片

本模块保留 `chargeActivity` 原四页主窗、三档任务行、每行最多四格奖励、七行兑换、原奖励格和滚动控件。原界面标题仍用于识别来源；运行时页签、烘焙充值目标图和提示改为本地中文任务说明。原 `.ui` / `.swf` 文件逐字节保留。没有真实充值、付费调用、私服 Socket 或原物品扣除。

本地规则由 API 的 `charge-native` 所有者维护，窗口只显示 `nativeCharge` 并发起严格动作：

| 原页序 | 本地含义 | 目标 / 结算 |
| --- | --- | --- |
| 0 | 当日已领取四项任务的积分，UTC 日 | 40 / 100 / 200；按日领取 |
| 1 | 累计任务积分 | 100 / 300 / 600；与旧 `points-gift` 共用 canonical 领取记录、奖励和邮件所有者 |
| 2 | 接入后实际活动积分消费 | 100 / 300 / 600；只记录新增真实费用，不回填历史，不以获得积分减余额推算 |
| 3 | 活动积分兑换普通材料 | 七项固定单份；积分费用和累计任务资格是两个条件；资格不扣除；每日限次 |

领取和兑换均显示 owned 本地确认；第一次打开确认框和取消均不发送 POST。确认才提交 `{type:"claim",index,tier,choice}` 或 `{type:"exchange",index,count:1,choice}`。`choice` 是 API 提供的 54 字符完整状态令牌，窗口不生成价格、物品或资格。`canClaim` / `canExchange` 的服务端 false 始终禁止操作。奖励只使用真实永久绑定普通材料 `11019/11001/11021/11002`，结算后寄邮件。不存在额外领取所有者。

## 编译资源与 ABI

模块四个固定 URL 均位于 `/flash/workshop-native/charge/`：

```
WorkshopNativeChargeBootstrap.swf
charge-original-library.swf
chargeactivity_v3_6_1_u1.swf
chargeactivity_v3_6_1_u1.ui
```

专用原 art 有 36 个 bitmap 符号，根时间轴一帧、无 sprite；本模块不声称恢复了原领奖动画。四份原 Morn 布局注册，外部滚动条闭包为已有 `uicomponent_v3_6_1_u1.swf` 的 id `22/128/129/151`，完整四个原 Lossless2 tag 共 1555 字节：主皮肤与动态 `$up/$down/$bar` 一并提入库。仅局部 skin QName 改名，原 bitmap tag 字节保留，首次打开无需预先打开其他活动。

业务库提取原 17 个 owner，加一个 bitmap 胶合 ABC，共 18 ABC。16 个旧加载 / 网络 / 确认 / 点击入口转为明确本地 dispatch；其余 85 个 body 原代码逐字节保留，审计另固定 21 个原方法，包括任务分组、排序、原主窗更新、奖励格、奖励渲染和兑换限次。没有整套新 core、空缺类 stub 或后台协议模拟。

现役宿主缺少原 `ItemManager.fillByID/fillNoBindInfoByID` 与 `DateUtils.dateFormat6`。相关原 QName 精确映射到 Bootstrap 的实际材料构造和 UTC 日期格式实现；`LanguageMgr` 转接明确本地文案，其余翻译仍委托现役宿主。原 Model 的三个计数 / CSV、三个 Dictionary、Date，以及两个 VO 均使用真实原类型。实际旧角色、域、代次、sequence、revision 和页面 UUID 必须匹配。

播放器注册 `workshopChargeAcceptSnapshot/RejectRequest/OpenNative/CloseNative/StatusNative` 五项；页面为 `workshopChargeRead/Request/Report`。首次打开只 GET；GET / replay 只同步静态视图。窗口不拥有 HTTP 或 UUID ledger。关闭清除 owned 确认、Morn handler、角色监听及根层；未确认请求仍由页面保留，迟到 POST 不重建窗口。共享 82 ABC 只由既有公共 loader 提供。

## 单项离线门禁

在项目根的 `source/ddtank-reborn` 下运行；输出目录必须全新：

```powershell
& 'D:\NODEJS\node.exe' --jitless --max-old-space-size=8192 scripts/workshop-native-charge.mjs '<fresh-output-dir>'
& 'D:\NODEJS\node.exe' --jitless --max-old-space-size=8192 scripts/native-charge/audit-candidate.mjs '<fresh-output-dir>'
```

`buildNativeCharge` / `auditCharge` 供主控联合包装使用。默认审计会写 fresh `offline-audit.json`，核实际 ABC、dispatch、未改 body、分支边界、五回调、原 bitmap、原 UI/art、宿主类和断开的旧调用。编译器 / `playerglobal` / core / 原美术与目录输入均固定 hash，Java 真实参数和退出码保存在 `build-logs/*.process.json`。四份 JS 文件已分别通过 `node --check`。

当前单项候选 `runtime/reference-activities-completion-20261014/native-charge-candidate-20261015-a` 完成两次 Java 编译及完整审计，外层 native exit 0、stderr 空；17 / 18 / 16 / 85 / 21 / 4 的实际计数与上述一致。`manifest.json`、`offline-audit.json` 和独立 native process receipt 保留在 runtime。此处仅表示离线可编译候选，不表示安装、AVM2 执行或视觉验收完成。

## 尚未验收 / 未移植

实际游戏里的第一次打开、四页切换、滚动、全部奖励格、中文字体与边界、角色变化、关闭 / 迟到 / replay、UTC 跨日与永久邮件领取周期仍需验收。原付款服务、原每日时区、原 Rate 4 奖励表、原材料扣除兑换后台均不可由公开客户端证明；本模块明确使用本地规则，不宣称原服全功能或属性完全相同。联合打包、隔离升级 / 回滚、计划、Obsidian 日志和 Git 发布由主控处理。
