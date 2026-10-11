# 本地 Workshop 运行与内容扩展

本次工作基于 DDTank 4.1 协议。真实原版 SWF/Ruffle 已显示大厅、商城装备页与海盗套装；套装原版背包、卸下后的混搭及穿回已核对。两个原版客户端已完成正常挑战、自然加载、实际发射/伤害、胜负、回大厅与重登保存。公开旧资源与模板不代表近年官方时装齐全。

## 独立本地栈

项目布局为外层 `DDTank-Workshop/`，源码在 `source/ddtank-reborn/`，私有存档、工具、素材覆盖、凭据和报告在外层 `runtime/`。运行依赖 Node 24、已安装的锁定依赖、真实编译客户端、有效 Resource、Ruffle WASM 和部署自己的 RSA 密钥/公钥覆盖。

`.env.workshop.example` 仅是配置格式，不能单靠复制空配置启动。私有 `.env.workshop` 的相对路径以源码根目录解析；`JWT_SECRET`、`ADMIN_TOKEN`、`PG_PASSWORD` 至少16字符且应独立随机生成。不要把配置、密钥、票据、测试账号或数据库上传到 Git。用户原始客户端和资源保留，只向覆盖层写入。

```powershell
node scripts/workshop.mjs start
node scripts/workshop.mjs status
node scripts/workshop.mjs stop
```

默认游戏网站 `http://127.0.0.1:5173`，后台 UI `http://127.0.0.1:5174`。真实 PostgreSQL 在 `127.0.0.1:55432`，API 8080、TCP 9200、WS 9300、policy843、内部控制9400。启动器显式设置进程 `TZ=UTC`，不修改系统时区；不会终止端口的既有占用者。

启停仅使用本次创建的 ChildProcess/IPC 和随机会话控制通道。游戏先于数据库停止，Windows 数据库使用 `pg_ctl` 正常关闭。退出记录在 `runtime/last-shutdown.json`；超时强停、非零退出或未退出均不会报告正常保存。不要把历史 PID 当作终止权限。

## 私有局域网

```powershell
node scripts/workshop.mjs start --lan=192.168.1.6
```

地址必须属于本机网卡且为私有 IPv4。`--lan` 可在仅有一张非虚拟私有网卡时自动选择，否则明确失败。只有游戏网站、API、TCP、WS、policy绑定指定私有地址；数据库、内部控制和后台 UI 仍只监听回环。管理员 REST 路由共享 API listener，继续受现有管理员角色鉴权保护。不会自动添加防火墙规则、转发端口或开放公网。物理异机连通性须单独核实。

实际私网地址的网页、API代理、客户端配置、RSA票据和加密WS大厅登录已通过；数据库/内部控制/后台UI仍只在回环。匿名管理员请求401、普通玩家403，既有管理员200。物理第二台设备连接未验证。

## 内容管理

后台物品新建补齐现有数据库必填默认值，复制保留完整模板并清除主键。套装编辑页可以读取当前草稿，检查素材路径、PNG chunk CRC、图标及 Show/Room/Game 帧网格，再预览原图。检查接口仅支持 CategoryID13，`renderingAccepted:false`：结构合格不能替代像素解码或游戏穿戴验收。

素材上传继续使用原有覆盖机制；模板管理、邮件发放和商城入口沿用现有服务。导入时使用唯一 TemplateID/Pic，保存字节摘要、原状态和删除范围，避免覆盖底包硬链接。`apps/api/scripts/workshop-wardrobe-smoke.ts --apply --hold` 是隔离测试流程，会创建本机私有测试账号，不能替代普通玩家的操作入口；重复执行时保留未回退账本。`--rollback` 仅回退本次记录且摘要吻合的素材/模板。

## 中文客户端

```powershell
node scripts/workshop-language.mjs verify
node scripts/workshop-language.mjs install
node scripts/workshop-language.mjs rollback
```

安装161个主要字典键的部署覆盖，保留 CRLF、BOM、重复键、顺序和格式占位符，原版客户端及原字典不变。回退校验账本，遇到用户另外编辑的覆盖文件会保留。新 Noto Sans SC 字体遵循 SIL OFL，许可在 `apps/web/public/fonts/OFL.txt`；来源固定为 [Noto CJK Sans2.004](https://github.com/notofonts/noto-cjk/tree/523d033d6cb47f4a80c58a35753646f5c3608a78)。字典不能翻译 SWF 内嵌位图按钮或数据库中的旧物品名称。

## 验证与备份

`workshop-smoke.ts` 走实际 REST→Flash RSA→TCP/WS 登录、大厅、双账号组房聊天及重连；`workshop-battle.ts` 走真实25秒机器人匹配、移动、开火、伤害、结算、翻牌、回大厅及存档重登。使用便携 Node24、`TZ=UTC`，不启用测试引擎或放宽票据。

`node --import tsx apps/api/scripts/workshop-shop-smoke.ts --run` 用新的本地测试角色，通过正常HTTP/RSA/WS登录购买原商城1310201商品。实服XML核对后，分别检查44响应、38精确扣159点券、64新增一件绑定7天海盗套装，以及正常退出后的稳定ItemID和新连接读回。44响应本身不足以证明购买成功。已实际完成一次购买、保存与精确回退；这项协议业务验证的 `renderingAccepted` 始终为false，不能代替原客户端商城操作验收。

该脚本仅访问回环API，账号与完整账本留在私有runtime。必要时补足测试余额，并在补款前落盘原余额、外观及库存基线；正常离线后仅将本次自有购买行置为IsExist=false/Count=0、还原余额，再以新连接确认不再加载。测试账号、任务副作用及失效物品行保留。`--rollback` 只恢复已记录的一批，不再次购买；缺少基线时明确失败并保留账本，不猜测原余额。存在未完成账本时拒绝开始新批次，尚未创建角色或购买的preflight失败可以安全重跑。证据为 `runtime/content-research/shop-lifecycle.json`。

`workshop-card-fixture.mjs` 将已核验备份恢复至随机独立数据库，独立启动实际API/游戏，固定副本地图与免费金币掉落，通过两场真实对局验证+15000金币。它不会改正常存档的地图/掉落，不代表随机正式服分支的概率覆盖。

`workshop-render.mjs` 用独立 headless Chrome/Ruffle 与原 public AS3 内部测试入口，读取网络/日志并保存原始截图，不模拟鼠标键盘。仅允许回环栈；测试票据不会被临时页面暴露到 LAN。截图生成不自动等于玩法验收。

`research/client/WorkshopWardrobeProbe.as` 编译后供 `--probe=wardrobe --fixture=wardrobe` 使用。编译SWF留在私有 `runtime/content-research/WorkshopWardrobeProbe.swf`（或 `--probe-file` 指定的私有runtime路径）。启动前必须有真实 `--apply --hold` 账本；角色、道具、模板与Pic由当次账本注入并精确核对，不复用旧测试编号。只有确认原公开卸下/穿回响应与角色完成显示才报告 `wardrobeRestored:true`；默认90秒上限，错误或超时明确失败，随后用正常 `--rollback` 核验回退。日志中的账号、密码与Flash key及URL编码形式统一遮蔽。参数化版本已用新的随机Pic、道具与账号实际穿卸并回退。

`workshop-peer-render.mjs` 运行两套原版SWF；AS3入口为 `research/client/WorkshopPeerProbe.as`，编译产物留在 `runtime/client-research/WorkshopPeerProbe.swf`。脚本使用 `node --import tsx`，`--validate` 只核对真实地图/协议导入。正常测试先等A的原RoomListView完成，再启动B；原版自由挑战要求发起者至少12级、目标至少4级，等级不足明确不通过。`--assist-room-loading` 只供隔离诊断，结果始终区分自然与辅助路径。已在纯测试角色临时合法等级下实际完成自然双客户端对局并还原等级；未修改默认Ruffle15秒执行限制。该Freedom对局验证金币保存，GP/Total/Win没有增量，不能据此宣称这些奖励通过。

```powershell
node scripts/workshop-backup.mjs backup
node scripts/workshop-backup.mjs verify '完整的.dump.json路径'
```

备份使用原生 pg_dump；verify 先校验 SHA256，只恢复到随机新库，六组关键表行数和全行摘要必须匹配。正常 `ddtank` 数据库不被覆盖。备份仅含数据库，上传素材、公钥覆盖、密钥、配置和源码需另外私密保存。

已执行窄测试：素材合并与启停4项、Flash覆盖/PNG5项、套装检查7项、后台字段/中文/草稿10项；卡奖励及既有fight12项。前端与API类型检查通过。Windows Vitest曾出现原生worker `0xC0000005`，单文件受控重跑结果单独保留，不将该环境故障算通过。独立恢复与真实机器人结算已验证；完整近年服装、所有副本、物理异机连接仍不能据这些检查推断通过。
