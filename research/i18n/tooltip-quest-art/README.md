# 原中文提示与任务素材

`original-resources.json` 对应已保存的参考服公开客户端资源。三份目标包分别移植121、115、96处同名位图引用，共332处；原图压缩数据和透明度保留，仅转换目标字符编号。它不代表整个客户端或服务端功能已移植。原SWF保存在项目runtime中，不随源码发布；缺少这些精确输入时拒绝重新构建。

`node scripts/workshop-tooltip-quest-art.mjs candidate-original <新目录>` 生成冻结候选和图片对照；`verify <候选目录>` 只读重建核对，`install <候选目录>` 安装，`verify` 核对现役覆盖层。旧 `candidate` 仍保留45处本地绘字模式，已安装原图版后拒绝直接降级。

安装沿用独立三文件日志，允许旧绘字版升级一次。升级保留旧日志、旧输出和永久原始备份，写入失败恢复升级前输出；外部新改动保留。`rollback` 恢复首次安装前状态，保留备份；回退无需原素材缓存可读，仍校验工具、配置、目标和备份。未知输入、工具、日志或候选摘要变化均拒绝。

92个纯BitmapData构造器的默认宽高跟随原类，仅追加所需整数和修改指定默认参数，所有方法体保持。4个原类默认尺寸比原图小1像素，明确pin原值，不猜尺寸。原任务八类奖励标签已逐项核对含义；换图不新增发奖能力，现有勋章隐藏分支与规则保留。

物品提示原图须配合 `node scripts/workshop-bag-layout.mjs install --original-tooltip-layout`：只在既有XML覆盖层增加coreI.xml的三个坐标调整，数值文字32/-4、绑定标记125/45，保留原有四项布局补丁。不要整包替换参考XML，其中存在不兼容内容。

离线回归：`node scripts/workshop-original-ui-bitmaps.test.mjs`、`node scripts/workshop-tooltip-quest-art.test.mjs`、`node --test --test-reporter=tap scripts/workshop-tooltip-quest-original.test.mjs`、`node --test --test-reporter=tap scripts/workshop-bag-layout.test.mjs`。图片对照和字节检查不等于游戏内AVM2验收；窗口、点击、动态正文与全客户端中文仍需实际复测。
