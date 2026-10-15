# 原至尊豪礼四页候选

本模块适配同一参考客户端的累计礼、钥匙轮盘、三人拼团及分期商店四页。原 43 个业务/UI owner、16 个 Morn 布局及原确认、结果、订单和分页控件保留。资源只读已保存的匿名公开输入；原 UI/art 不改字节。原私服配置仅作行为证据，不直接成为本地奖池、价格或概率。

本地规则由 `forthright-native` API 唯一持有，公开 `nativeForthright`，仅新确认动作附 `nativeForthrightAction`。累计礼与旧豪礼共用领取键；轮盘三轮十格及两种凭证使用本地台账。拼团需要三名真实角色，退出只退本人，团长才可取消整团；手动结算处理团内全部待退积分，历史退出成员仍保留。分期按明确的 UTC 时段和本地积分报价结算，单笔订单退款与拼团结算分别确认。两个原抽奖按钮均一次单抽；没有无限连续请求。

原指针 `movie1` 为 39 帧循环装饰，原结果 `movie2` 第 22 帧发送 `effectComplate`。适配器保留原 `roll → __enterHandler → _stopRoll → showEffect → __effectComplate` 方法体；整个动作锁由适配器持有。新结果先用上一轮目录播放，原完成事件或用户明确跳过后才静态同步下一轮。GET、UUID 重放不播放抽奖动画；关闭移除原/owned 监听并停止 movie。已提交请求由页面原 UUID 台账保存，迟到响应不重开窗口。

缺失的 `ActivityNormalEvent` 来自同一原 core 的真实 ABC，不是空 stub。原 `turnGoodsIDDic:Dictionary` 被赋 `DictionaryData` 的不一致由本地真实 `Dictionary` 目录修正。付款检查替换为本地资格/报价/确认；不加载缺失支付工具。四个原 Lossless2 滚动条标签以 `workshop.forthright.skin.Scroll` 及 `$up/$down/$bar` 别名打包，位图字节保持且不与其他模块冲突。每次打开均有完整资源闭包，不依赖先开其他活动。

固定运行资源：

- `/flash/workshop-native/forthright/WorkshopNativeForthrightBootstrap.swf`
- `/flash/workshop-native/forthright/forthright-original-library.swf`
- `/flash/workshop-native/forthright/forthrightactive_v3_6_1_u1.swf`
- `/flash/workshop-native/forthright/forthrightactive_v3_6_1_u1.ui`

构建入口 `buildNativeForthright`，审计入口 `auditForthright({projectRoot,outputDir,sharedPath})`。使用现有 Flex/Java 与 `D:\NODEJS\node.exe --jitless`，输出必须为全新目录。源码和 runtime 原件、失败候选分开；没有在源码目录附带游戏资源。共同桥、共享 loader、联合安装器由上层唯一 owner 接入，本模块不复制共享 82 ABC。

最终单模块候选 `native-forthright-candidate-20261015-e` 的构建及默认写报告审计均真实退出 0，两个 Java 编译子进程退出 0。库含 43 个原 owner、同 core 的真实事件 owner 及局部滚动条胶合，共 45 ABC；83 个方法派发到本地适配器，230 个其余原方法体保持字节，另逐项核对 29 个原方法。四个滚动条标签、原 UI/art 字节保持；依赖审计缺失宿主类及旧付款/网络调用均为空。此前 a/c 编译失败日志和 b/d 历史候选保留。五个构建源码与本 README 分别纳入 runtime 冻结清单，未把文档当作编译输入。

仍未移植真实付款、全服库存、跨服邀请、广播及未知私服经济；原邀请扩展框不作为已恢复功能。运行时替换中文标题、字体、本地费用、UTC 日期及凭证说明，不宣称原 UI/art 已重绘或视觉合格。离线编译、字节/依赖审计不能替代 AVM2 首开、四页操作、中文位置、原动画、三角色拼团、邮件领取及关闭/重试的实际验收；候选尚未部署。
