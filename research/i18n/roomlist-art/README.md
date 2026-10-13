# RoomList 副本列表中文位图

沿用原「难度」成品，增加「房间名称」「地图」「人数」「上一页」。五项均替换 `ui/vietnam/swf/roomlist.swf` 中 tag 35 的内嵌 PNG，原尺寸、alpha、文字框外像素保持。相对当前含「难度」的 overlay，仅四个 tags 改变，其余 80 tags、SymbolClass、1 个 ABC、SWF header 与尾部保持原字节；上一页箭头保留。

| Character | 字幕 | 成品 |
| --- | --- | --- |
| 58 | 难度 | `58.png` |
| 35 | 房间名称 | `prepared/35.png` |
| 44 | 地图 | `prepared/44.png` |
| 27 | 人数 | `prepared/27.png` |
| 20 | 上一页 | `prepared/20.png` |

五张 PNG 是已审核的成品，`zh-CN.json` 的 `preparedImage` 固定各自文件 SHA。安装器只读取成品像素，不重新绘制按钮文字；region 中的字号、采样和描边参数保留原制作记录，不参与像素替换。顶层字体配置仍用于报告图注。原难度 1191 个 RGB 像素变化保持；新四图分别改变 1277、565、803、715 个像素，alpha 和框外像素均无变化。

| 对象 | SHA256 |
| --- | --- |
| 源 `roomlist.swf` | `58fac028f6c484657748e18a1045f9bf658d823c49208369786a622a35c3930a` |
| 原 tag 35（含 tag header） | `da6673adc8fc77aced0d5882e56fa8609dc4d81ad7383a544de1024fc5462f27` |
| 成品 `58.png`，5407 字节 | `51c173b1142a8b86cb40678e258617b19d5dbb2a740d2e4b7380f7f1ad52b7fd` |
| 原难度 overlay，475128 字节 | `39ac59a0318c01ed88d8ee8314ee04ea5189669a6181a3e05df32df83994b37f` |
| 五项重建 SWF，464187 字节 | `c84a10f48797aa409a172461c87add4e45cc4c075a050ea1506957970320a593` |

沿用现有 `scripts/workshop-bag-art.mjs`，只增加模式：

```text
node scripts/workshop-bag-art.mjs verify --roomlist
node scripts/workshop-bag-art.mjs install --roomlist
node scripts/workshop-bag-art.mjs rollback --roomlist
```

`verify` 会在 `runtime/client-text-followup/roomlist-candidate/<timestamp>/` 生成私有报告，读取当前 overlay/账本但不安装。`install` 使用原有原子替换、备份、漂移拒绝与失败恢复流程，账本为 `runtime/client-overlay-roomlist-art.json`，目标为 `runtime/client-overlay/ui/vietnam/swf/roomlist.swf`。未知 overlay 会拒绝；`rollback` 沿用账本恢复原 overlay，原先无 overlay 时删除本次目标。源 SWF 与 vendor 均不写入。模式不接受与其他 asset 模式或 `--background` 混用。

实际完成的离线验证：

- `node scripts/workshop-bag-art.test.mjs` 通过，包括原 tag 36 回归、PNG tag 35 的格式/源/hash 拒绝、框外及 alpha 保护、冻结输出门。
- 当前五项配置已调用原 CLI 的 `verify --roomlist`，严格重建为冻结的 `c84a10f4…20a593`。原难度单图重建证据保留为历史阶段；本轮通用位图窄测试实际通过。
- 冻结成品来源：`runtime/online-box-followup-20261013/pve-roomlist-difficulty-candidate-20261014/`；该目录未改写。此前已实际查看原尺寸、1.5× 深浅底及 6×，并由独立审查确认清晰、居中、没有外文残留或裁切。6× 可见局部补绘的横向纹理，不代表恢复了被原字遮住的真实底纹。

四项新增候选及独立字节审查：`runtime/online-box-followup-20261013/roomlist-compatible-caption-integration-20261014/`。现有源文件与 vendor 有既有位图格式差异，本次不覆盖源 SWF 或 vendor；54 的服务器表头仍受原 alpha 限制，未加入替换。五项成品可从现有 source 一次重建，也可由原难度 overlay 增量重建，输出逐字节相同。

本目录记录源码接入及离线验收。实际安装/HTTP证据由私有 runtime 收据记录；原完整组件、hover/down、文字动态位置与全页面布局仍待运行验收。
