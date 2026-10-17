# 夜景大厅悬停资源

现用大厅曾只替换夜景底图，12 个建筑的悬停帧仍引用白天贴图，鼠标移入时出现矩形接缝。

`night.zh-CN.json` 将这 12 张位图对应到同一夜景原件；另复用婚礼提示的原版中文字图和布局。仅移植压缩图像 payload，并将婚礼提示 Shape 的两个位图引用映射到本地 ID。原件必须匹配清单里的完整 SHA256；不提交第三方素材。

`scripts/workshop-hall-hover.mjs` 的 `patchHallHover(sourceBytes, donorBytes)` 返回候选 `out` 与变更清单，不自行写入现用文件。调用方应保留原件、检查候选并原子安装。已安装时重复调用不变；目标资源、底图或主时间轴不匹配时拒绝覆盖。其他字图、新手提示、点击区域、13 帧时间轴和 ABC 原样保留。

验证：`node --test scripts/workshop-hall-hover.test.mjs`。本地另对真实资源核验仅 14 个 Tag 改动，并离线合成检查 12 个悬停态。静态验证不能替代玩家的游戏内验收。
