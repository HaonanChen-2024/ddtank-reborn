# RoomList「难度」位图

这里只把 `asset.DungeonList.hardLevel_PVE` 的 `Dificuldade` 改为「难度」。目标是 `ui/vietnam/swf/roomlist.swf` 中 character 58、tag 35（内嵌 PNG），尺寸仍为 111×29。其余 83 tags、SymbolClass、1 个 ABC、SWF header 与尾部保持原字节。

`58.png` 是已审核的成品，`zh-CN.json` 的 `preparedImage` 固定文件 SHA。安装器只读取成品像素，不重新绘制按钮文字；region 中的字号、采样和描边参数保留原制作记录，不参与这次像素替换。顶层字体配置仍用于报告图注。标签文字框为 `[10,3,92,18]`，1191 个像素的 RGB 改变，全 3219 个 alpha 及框外 1563 个 RGBA 像素保持不变。

| 对象 | SHA256 |
| --- | --- |
| 源 `roomlist.swf` | `58fac028f6c484657748e18a1045f9bf658d823c49208369786a622a35c3930a` |
| 原 tag 35（含 tag header） | `da6673adc8fc77aced0d5882e56fa8609dc4d81ad7383a544de1024fc5462f27` |
| 成品 `58.png`，5407 字节 | `51c173b1142a8b86cb40678e258617b19d5dbb2a740d2e4b7380f7f1ad52b7fd` |
| 重建 SWF，475128 字节 | `39ac59a0318c01ed88d8ee8314ee04ea5189669a6181a3e05df32df83994b37f` |

沿用现有 `scripts/workshop-bag-art.mjs`，只增加模式：

```text
node scripts/workshop-bag-art.mjs verify --roomlist
node scripts/workshop-bag-art.mjs install --roomlist
node scripts/workshop-bag-art.mjs rollback --roomlist
```

`verify` 会在 `runtime/client-text-followup/roomlist-candidate/<timestamp>/` 生成私有报告，读取当前 overlay/账本但不安装。`install` 使用原有原子替换、备份、漂移拒绝与失败恢复流程，账本为 `runtime/client-overlay-roomlist-art.json`，目标为 `runtime/client-overlay/ui/vietnam/swf/roomlist.swf`。未知 overlay 会拒绝；`rollback` 沿用账本恢复原 overlay，原先无 overlay 时删除本次目标。源 SWF 与 vendor 均不写入。模式不接受与其他 asset 模式或 `--background` 混用。

实际完成的离线验证：

- `node scripts/workshop-bag-art.test.mjs` 通过，包括原 tag 36 回归、PNG tag 35 的格式/源/hash 拒绝、框外及 alpha 保护、冻结输出门。
- 从真实源 SWF 和本目录 `58.png` 调用新 owner 的 `patchSwf`，在内存中重建，再逐字比对冻结候选；完全一致，并复读确认源文件不变。此次没有调用 CLI 的 `verify`、`install` 或 `rollback`，没有生成新 runtime 报告或改账本。
- 冻结成品来源：`runtime/online-box-followup-20261013/pve-roomlist-difficulty-candidate-20261014/`；该目录未改写。此前已实际查看原尺寸、1.5× 深浅底及 6×，并由独立审查确认清晰、居中、没有外文残留或裁切。6× 可见局部补绘的横向纹理，不代表恢复了被原字遮住的真实底纹。

本次仅完成源码接入。原组件、hover/down、完整副本列表与 live 安装尚未验证；后续安装与运行时验收由主控制器执行。
