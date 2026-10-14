# 原 PairBox 本地适配候选（实验性，未安装）

**最新联合检查点（2026-10-15）：** `native-unified-candidate-20261015` 已统一82共享/10衣橱/26翻牌类；共同桥和网页角色/UUID宿主已实现，25网页离线测试通过。18项资源的实际SWF隔离升级/重复/验证/回滚通过，尚未部署或运行原翻牌。旧候选b与下方待接入说明保留为历史；新构建入口和当前合同见 [native-shared/README.md](../native-shared/README.md)。普通关闭保留宿主；断线沿原UUID显式重试，AS回调异常则在网页核对原收据，再重新进入游戏恢复窗口。

此目录只构建原翻牌窗口候选。保留原 10 个布局、8 × 4 卡片、卡片翻开/匹配动画与重置动画；模块内业务改接现有 `pair-native` HTTP 原子事务。没有修改正式 core、网页入口、数据库、服务或衣橱。编译/结构检查不代表 AVM2、Ruffle 或窗口已经运行通过。

## 历史候选b的构建及产物

从仓库根执行，输出目录必须不存在：

```powershell
node scripts/workshop-native-pair.mjs '<新的候选目录>'
node scripts/native-pair/audit-candidate.mjs '<该候选目录>'
```

本轮有效产物：`runtime/reference-activities-completion-20261014/pairbox-native-candidate-20261015-b/`。`a` 是首次构建，不应安装。`manifest.json` 记录每个输入/输出哈希、26 个 Pair owner、82 个共享 owner 与逐方法修改。`offline-audit.json` 为窄静态验收及当前 host 类依赖列表。构建器不覆盖旧目录，无网络请求。

- Bootstrap：Flex 编译成功，10,506 B；SHA-256 `4650d28cd8e21526b6eed2890e678ffd8980c92ef8e1de55939cb8cd145d9463`。
- 原活动库：26 ABC，18,752 B；SHA-256 `7589bf8a537f2e0581537a6c3bd3437eb821089a2bf72916ac3b281903080c49`。
- 独立共享库：82 ABC，136,712 B；SHA-256 `0a4ce53c90db21b70e99d8b6ab40779248e482245aadae2c977985716ccddad0`。
- 原 Pair SWF / `.ui`：按原件 SHA 固定，复制后保持原字节。7 个共享 skin 分成 7 个单符号 SWF，原 JPEG3/Lossless2 位图标签逐字节不变；已存在的类跳过加载，避免为补一个 skin 重复载入整个 UI 包。
- 9 个业务 owner 的 99 个方法体统一转发到 `WorkshopNativePairBootstrap.dispatch`。原 Manager socket 初始化、725 回包处理、自动重置、44 商城购买、卷轴付费路径均不再执行；旧 handler 由本地闭包替代。
- 第 10 个适配 owner 是 `PairBoxRewardPoolItem`：现役 `ItemManager` 没有新版静态 `fillByID`，仅将该 QName 改为模块内 `fillInventory`，由真实 `InventoryItemInfo` + 现役 `ItemManager.fill` 完成；所有方法体不变。没有改全局 ItemManager。
- `PairBoxCardItem`、`PairBoxModel` 原 ABC 完全不变。不会将旧 12 格网页配对存档转换成 32 格。

## 历史候选b的共享加载合同（现已在联合候选实现，运行待验）

当前正式衣橱仍携带完整92 ABC；联合候选已拆分，但未部署。**旧候选b不能直接接到正式入口。** 下列为旧设计记录，当前加载器只复用本owner自己的成功加载；未知既有类需重新进入游戏。

1. 主控建立唯一共享载入 owner，串行管理 App/Config/Morn 等 82 类，等全部加载完成，再启动衣橱或翻牌。
2. 若衣橱 92 包已经加载，确认其同一来源/完整性后复用其 82 类；绝不再次加载 `pair-shared-library.swf`。
3. 若首次打开翻牌，可由该唯一 owner 先加载 82 类；随后衣橱必须只加载自己的 10 类，不能再载入原 92 包。两个活动同时请求也只能触发一次共享加载。
4. Pair Bootstrap 自身**不加载共享 82 包**。调用者须传 `sharedOwnerReady:true`，并将 Bootstrap、Pair 26 ABC、Morn 与原图加载到同一受控 `ApplicationDomain`，即衣橱使用的共享 DisplayLoader 域。不能靠另建子域掩盖重名类。
5. 不调用 `App.init`；沿原 owner 只设置真实 `StageReferance.stage`、`App.asset` domain 和 `View.uiMap`。原布局中 `View/PairBoxShopAlert.xml` 大写 `V` 保留。

需分别验收：全新会话→衣橱→翻牌，及全新会话→翻牌→衣橱；另验并发打开、反复关闭重开、旧大厅/背包无回归。上述均未运行。

## 页面接口（旧候选b未接入；当前网页宿主已实现，运行待验）

初始化：

```js
bootstrap.startNative({
  expectedUserId: actualCurrentSelfId,
  generation: hostChosenWindowGeneration,
  baseUrl: '/flash/workshop-native/pair/',
  sharedOwnerReady: true,
});
// status.phase == 'ready' 后，用户显式打开：bootstrap.openNative()
```

AS → 页面：

| 方法 | 同步返回 | 后续行为 |
|---|---|---|
| `workshopPairRead(characterId,generation,sequence)` | `{accepted:true}` 或 `{accepted:false}` | GET `/api/account/activities?characterId=N`，异步返回完整 snapshot；不创建牌局。 |
| `workshopPairRequest(characterId,generation,sequence,action)` | `{accepted:true,requestId:uuid}` 或 `{accepted:false}` | 页面先保存 pending UUID/原 action，再向 `/api/account/activities/pair-native/action` 提交。 |
| `workshopPairReport(status)` | 无要求 | 显示实验状态、错误和未确认请求，不根据状态发奖。 |

页面 → AS（已注册的 ExternalInterface 回调）：

```js
workshopPairAcceptSnapshot({
  generation, sequence, requestId, // 只读时无 requestId
  snapshot: completeActivityResponse,
});
workshopPairRejectRequest({generation,sequence,requestId,definitive,message});
workshopPairOpenNative();
workshopPairCloseNative();
workshopPairStatusNative();
```

`sequence` 只是该模块每次请求的递增关联号，不是服务端 UUID；必须按收到的原值回传。异步回调要发生在同步 accepted/UUID 返回之后。仅当前 pending 的 generation/sequence/角色/UUID 能应用；snapshot `revision` 还须不倒退。当前服务端 `ActivitySnapshot` 确有 revision，来源为钱包事务 Revision。

使用现有 `service.ts`/`types.ts` 合同：所有响应有 `nativePair`；只有新鲜成功动作有 `nativePairAction:{requestId,effects}`，GET/其他活动/replay 没有。replay 取最新 snapshot，只静态同步，不重复动画或奖励。关闭窗口后响应只更新缓存，不重新打开。AS 不生成 UUID、没有 JWT、没有 HTTP POST、没有自算配对发奖。

页面必须与网页活动中心共用同角色 pending 锁/UUID 账本。超时或未知提交结果须保持 pending，用原 UUID/原 action 由用户显式重试；不能给 `definitive:true`，不能新建 UUID 自动重发。刷新不自动重发。`definitive:true` 仅用于已知未提交或明确拒绝的请求。只有页面完成鉴权、真实当前 Self 绑定及 API 后，才可声明已接入。

## 已实现的候选交互

- 打开只读；未开始时原重置位置显示“开始”，显式 `start` 才建局。
- 单翻默认仅免费券/卷轴；用完后原确认窗显示活动积分成本，确认后才 `choice:'points'`。单翻按服务端公开 partner 同步，调用原卡片 `play`，等真实 COMPLETE 后解锁；未匹配卡持续正面。
- 一键沿原一键确认窗：仅券或显式积分补足，单次 `flip-all`；原结果窗按 matched effects 汇总同材料多次奖励数量。
- 原重置动画仅在显式重置成功后播放；GET、重开、UUID replay 不播放。全翻完和当日限额由服务端投影控制。
- 原卷轴购买窗改成本地活动积分，数量 1..64 且不得超过 buyRemaining；原印记商店仅 4 个本地材料，兑换数量 1..10。没有点券/礼金/远服付款通道。
- 奖品 ID 1..4 严格对应 11019/11001/11021/11002，不加载原参考服 68 行奖池。模板缺失时阻止打开；奖品进入服务端邮件，不改 AS 背包。

## 静态检查结果与剩余门禁

本次编译及结构审计通过：26 Pair / 82 共享，99 转发方法，所有非转发方法体保持原字节，活动 ABC 的实际指令中无 `SocketManager`、`GameSocketOut`、`CheckMoneyUtils`、旧 `sendBuyGoods`/`sendBuyReel`/新版商城查找/原价格 getter/`fillByID` 调用。常量池里可能保留旧字符串，不把未执行的字符串当成仍会发包。

活动 ABC 的 11 个现役静态类依赖均存在：BagCell、FrameEvent、DataAnalyzer、ComponentFactory、ObjectUtils、InventoryItemInfo、ShopItemInfo、PkgEvent、ItemManager、SoundManager、DictionaryData。细分 owner/method 见 `offline-audit.json`。Bootstrap 额外动态依赖当前 StateManager、PlayerManager、MessageTipManager、StageReferance、LayerManager，以及共享库的 App/Config/View/Handler；须由主控真实宿主验收。类存在不证明其全部成员或运行行为兼容。

未执行：AVM2 verifier / Ruffle 加载；原窗口首屏及动画；全部点击路径；UUID 断线/重试与页面同步锁；真实角色切换；邮件回读；两种活动加载顺序。原 XML 布局、按钮文字和字体的实际显示也需整页截图确认，不以编译成功代替。主控先只读复核这些文件和收据，再决定运行候选。

## 唯一共享加载器后续候选

后续构建 `scripts/native-shared/build-activities.mjs` 改由唯一共同 owner 加载共享类。18 项资源清单、角色及代次合同和待验门禁见 `scripts/native-shared/README.md`。上文保留旧 Pair 独立候选的离线证据；其中私有 `pair-shared-library.swf` 不得重复部署到统一候选。
