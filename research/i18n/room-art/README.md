# Room 房间座位中文位图

本目录保存「关闭座位」「开启座位」「房主」「公会」四张已审核 PNG，替换 `ui/vietnam/swf/room.swf` 的原 tag36 位图。`zh-CN.json` 和四图沿用最终 `attempt-03` 原件，安装器只读取成品像素，不重新绘字；所有非目标194 tags、SymbolClass、ABC、header、尾部和原坐标保持。

| Character | 字幕 | 尺寸 | 允许修改的 ROI | alpha |
|---|---|---|---|---|
| 69 | 关闭座位 | 170×203 | [9,152,153,28] | 全图保持 |
| 62 | 开启座位 | 170×203 | [13,150,146,27] | 全图保持 |
| 65 | 房主 | 92×24 | [2,2,81,20] | 仅 ROI 内允许，435像素改变 |
| 64 | 公会 | 34×18 | [1,1,32,16] | 仅 ROI 内允许，221像素改变 |

原 `RoomPlayerItem` 空位 opened=true 使用69（点击关闭），opened=false 使用62（点击开启）；等级6开位规则、frame、hitArea、关闭十字、印章及位置未修改。65保留原棕色渐变底，其中文字外的清理区按原图列方向采样；64保留透明背景。69/62 的原字 mask 内可见局部底纹平滑，没有被原字遮盖的原底纹，不能称为逐像素恢复。

| 对象 | SHA256 |
|---|---|
| 原 source `room.swf`，2211842字节 | `a4a33f05dfd77cad4fa237d97a0594e9dc64f32c1266815540603beb8da53aed` |
| 最终候选，2202394字节 | `ecfa5ddb0dbc1ae949b18ada1e6c2bed20fb62d6193c920c1fa6f7a9c5fe4503` |

沿用原 `scripts/workshop-bag-art.mjs`，增加互斥 `--room` 模式：

```text
node scripts/workshop-bag-art.mjs verify --room
node scripts/workshop-bag-art.mjs install --room
node scripts/workshop-bag-art.mjs rollback --room
```

`verify` 生成 `runtime/client-text-followup/room-candidate/<timestamp>/` 的报告，读取 overlay/账本但不安装；报告中203px高座位图使用独立240px行高，避免截掉下方文字。`install` 沿用原子替换、备份和漂移拒绝，账本独立为 `runtime/client-overlay-room-art.json`，目标为 `runtime/client-overlay/ui/vietnam/swf/room.swf`。源 SWF、vendor、游戏逻辑不写入；未知 source/base overlay 会拒绝。`rollback` 沿用原账本恢复逻辑。该模式不能与其他 asset 模式或 `--background` 混用。

候选来自 `runtime/online-box-followup-20261013/room-seat-chinese-preparation-20261014/attempt-03/`；独审见 `room-seat-chinese-review-20261014/report.json`。独审通过离线候选并记录底纹限制。四图及配置已冻结，ROI外原像素保持；字体、透明度和字号均沿用该候选。

源码接入已实现，原 `workshop-bag-art.test.mjs`、CLI严格重建和本地 overlay 安装已通过。服务的静态资源索引在启动时建立，首次新增 `room.swf` overlay 后须正常重启服务，并核对 HTTP 完整响应与上述最终候选一致。实际部署结果记录在工作区执行计划和独立部署收据中。

原客户端房间整页、hover/down、动态缩放、实际座位切换与房间交互仍待验收；离线位图和安装检查不等同于游戏验收。
