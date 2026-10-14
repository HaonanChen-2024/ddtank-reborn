# 原版魔法衣橱构建与接入

这是构建模块，不会安装资源、修改 `2.png`、登录、发送游戏协议或访问数据库。原窗口、三套 Morn 布局、原美术及 52 套目录保留；适配后的原业务库为 92 个 DoABC。原两处背包持有检查改用旧客户端真实 `getItemByTemplateId`，不伪造背包物品。

## 构建

在仓库根运行：

```powershell
node scripts/workshop-native-wardrobe.mjs <不存在的输出目录>
```

也可导入 `buildNativeWardrobe({ outputDir, projectRoot, javaPath })`。默认项目根为仓库上两层，Java 为当前用户的 `.jdks/openjdk-22.0.1/bin/java.exe`。`source-spec.json` 固定本地原件、原参考 core、编译器和 PlayerGlobal 哈希；输入不符或输出目录已存在时拒绝构建。

输出包含：

- `flash/workshop-native/wardrobe/`：Bootstrap 和五份原业务/美术/布局/目录资源，共六文件。
- `bridge/WorkshopNativeWardrobeBridge.doabc-tag.bin`：**含 SWF tag 头**的单个 tag 82，owner 为 `workshop/native/WorkshopNativeWardrobeBridge/v1`，flags 为 1。
- `bridge/WorkshopNativeWardrobeBridge.swf`：编译检查产物，不作为第二套独立客户端运行。
- `manifest.json`：输入、输出及 ABC 哈希，公开 URL 路径和接口。
- `build-logs/`：两次 Flex 编译输出。

构建器检查两个独立类的方法签名、92 个原 ABC 与四个接口存在性、三项回调名和输入不变。Flex 的 ProductInfo 含编译时间，外层 SWF 哈希可能随构建改变；未重写该元数据。

## 唯一桥接 owner 的插入

集成器负责将完整 DoABC tag 放在同一 `ApplicationDomain` 的 `chickActivation/ChickActivationManager` tag 之前，验证 owner 与全局类 `WorkshopNativeWardrobeBridge` 均不重复。不要再把桥接 SWF 作为文档根类加入原 `SymbolClass`。

在当前已保留活动和签到回调的 `ChickActivationManager.setup` 尾部，追加：

```text
getlex       ::WorkshopNativeWardrobeBridge
callpropvoid ::init, 0
```

两个名称都使用公共空 package namespace；新增名称池项，保留现有项。`init()` 只注册回调，内部检查 `ExternalInterface.available`，不加载、不弹窗、不领奖。

2026-10-15 只读核对现役 owner 的依据（集成时必须重新核验，不能直接假定仍相同）：

```text
2.png SHA256: fdf907f135f5f99a2cc05adddeec9a63f02d0c8a3dafbf896de31d0e9fe32bf2
Chick ABC SHA256: d81a0d2cf2387b2ee76e9b3910446d59be36143afb47a64784a4ba55fbd4250c
setup method: 4
setup code SHA256: 10ee4103b30bc8cacfacf1ddfd78322befefe256f93cfd83db1c09dfc760fce2
shape [maxStack, localCount, initialScope, maxScope, codeLength, exceptions]: [3,1,5,6,82,0]
```

该版本已经注册 `workshopOpenActivation` 和 `workshopOpenSign`。尾部现有 fallback `nop` 位于 code offset 78，`debugline` 位于 79，`returnvoid` 位于 81；在 **79 前**插入上述调用时，现有分支仍落到 78，无需改分支偏移。调用仅需一格栈，当前 maxStack 3 足够。必须保留两个旧回调及原方法字节，不可把旧的 47 字节 baseline 直接覆盖到当前 owner。

## 网页接口

```text
workshopOpenWardrobe(expectedCharacterId:Number):Boolean
workshopStatusWardrobe():Object
workshopCloseWardrobe():void
```

Open 返回 `true` 只表示已接收当前角色的请求；网页应轮询 Status，确认 `phase === 'open' && visible === true`，再关闭网页活动中心。`workshopWardrobeReport(status)` 是可选通知，正确性不依赖该回调存在。

Status 包含 `phase/ready/visible/actualUserId/expectedUserId/notice/errors` 和目录及当前窗口 `viewState`。打开前、加载完成及实际弹出前均校验真实 `PlayerManager.Instance.Self.ID` 和 `StateManager.currentStateType === 'main'`。路径由现役 `PathManager.FLASHSITE` 获取，必须以正常 `/flash/` 根结束，再加载 `workshop-native/wardrobe/`；没有固定角色、端口或测试凭证。

Close 在任何阶段清除待打开意图；资源可以继续加载，但 Bootstrap 使用 `autoOpen:false`，不会在用户取消后自行弹出。加载完成后同角色再次 Open 可复用已加载模块。加载错误或内部 60 秒超时记录 `phase:'failed'`，Close 不清除错误状态；同一域不重复导入类，需重新进入游戏后重试。网页自己的 15 秒等待超时或 AbortSignal 取消应调用 Close。

Bootstrap 不调用会改动整套舞台的 `App.init`，只设置真实舞台、共享资源域和原布局；原窗口挂到现役 LayerManager。目录运行时依据真实 ItemManager 保留部件模板完整的套装，现有已验收候选显示 31/52 套，21 套缺模板在原分析器前排除，窗口明确提示，原 52 套 XML 不改写。模板存在并不保证每张预览 PNG 存在；对应资源依赖修复由独立验收/安装流程处理。

## 验收范围

2026-10-15集成状态：构建、隔离安装/重复安装/验证/回滚及实际HTTP文件完整性通过；正常 `/play` 的首次打开、角色不一致拒绝和立即取消已验证。正式连续翻页仅完成7页，随后Ruffle出现GC断言，未通过稳定性验收。早期隔离候选11页成功不能替代本次失败。活动中心保留目录默认入口，原窗口只标为试用；不要将当前桥标记为已完整验收。

构建模块自身只核验静态编译、接口和输入完整性。较早候选的分页、分类、部件窗口与开关证据保留；正式桥接的稳定连续翻页、错误后的恢复和重开仍待验，不能以构建成功或早期候选成功替代。
