# 泡泡茶官方效果升级

用户提供官方 v17.1.1 BallList/BombConfig 和带来源记录的资源。四个专属 Ball 与本地武器9107258绑定相同；仅将已证明不同的 Crater、ShootSound、BombSound、Power、Radii 和所选 FlyingPartical 对齐，保留其余字段及玩家数据。

| 分支 / Ball | Crater | Shoot / BombSound | Power | Radii | Amount | FlyingPartical |
|---|---:|---|---:|---:|---:|---:|
| 15601 | 15601 | 254 / 252 | 1 | 60 | 1 | 518 |
| 156012 | 15601 | 256 / 252 | 1 | 60 | 1 | 518 |
| 156011 | 15601 | 255 / 252 | 1 | 60 | 1 | 518 |
| 156013 | 15602 | 257 / 253 | 0.65 | 65 | 3 | 498 |

Sound252–257 的有效 DefineSound 数据及 MP3 已与官方战斗音频包逐字节核对，复用现有注册。已核对官方 emitter 518/498 的定义及贴图依赖；四分支使用 518/518/518/498。

坑图来自 http://cdnres.ddt.1322game.com/image/bomb/crater/15601/ 和15602/，使用原小写 crater.png / craterbrink.png。服务端沿用既有 alpha>100 图像派生格式，独立记录四Ball的shape并移除旧兼容shape引用；不修改全局bombs.ddtb或其他武器。普通与必杀完整掩码面积变化约-7.91%/+157.67%，不等于实际一发新增挖坑或伤害变化。

启动桥可选effects清单固定官方两XML、音频同源收据、资源和形状候选。事务只接受完整旧状态或带有效日志的新状态，保护装备与旧共享Ball，重复启动零更新；差异、额外共享引用或归属不符时停止。旧视觉部署仍兼容。

本次四张PNG已安装并HTTP验证；数据库与战斗配置待用户批准重启后应用。未运行浏览器或进行游戏验收。完整来源URL、候选和本地证据见runtime/official-capture-20261017/SOURCES.json及runtime/feedback-official-bubble-20261017/；不将本机配置、凭证和捕获缓存提交到仓库。
