# 本地 Workshop 运行与内容扩展

## 继续修改中文文字

客户端字典仍由 `research/i18n/zh-CN-overrides.json` 与 `scripts/workshop-language.mjs` 管理。本轮新增194条，累计355键/358行，覆盖装备类型、背包、商城、房间、副本、好友和邮件部分提示。新增翻译必须对应原键，保持 `{0}` 等位置占位符、CRLF、BOM 和重复键；`verify` 只核验，`install` 保留上一次部署备份。图片里的文字需要单独处理，字典覆盖不代表全部按钮已中文化。

核心 SWF 的已知越南语/葡萄牙语常量另由 `research/i18n/zh-CN-literals.json` 与 `scripts/workshop-literals.mjs` 管理。工具沿用现有 ABC 字符串补丁器，仅写 `runtime/client-overlay`，保留当前部署的 RSA 公钥和其他字符串、方法代码及位图。当前三个文件共替换 42 个常量位置：`2.png` 34 个、`3.png` 5 个、`DDT_Loading.swf` 3 个；称号译名为本地语义翻译，不能用于推断官方时装名称或素材映射。

安装或回退 SWF 覆盖后需重启服务以重建静态文件索引；在源码根目录依次执行：

```text
node scripts/workshop.mjs stop
node scripts/workshop-literals.mjs install
node scripts/workshop.mjs start
```

`node scripts/workshop-literals.mjs verify` 核对当前补丁与备份哈希。回退时将 `install` 换成 `rollback`；只恢复账本拥有的覆盖文件，原 vendor 与仓库中的二进制均不写入。自行修改过部署文件时工具拒绝覆盖；更新该批译文前先回退，保留其他自定义内容。

网页游玩页的角度、距离、力度与三类加载错误已接入现有 PT/EN/中文语言字典，保留已保存的语言偏好。

本轮实际核验：web构建、已有4项语言回归、1项SWF字节保留/重复补丁测试通过。安装、精确回退与重新安装均通过；当前三个SWF的全部ABC非字符串内容、其他字符串及位图与备份一致，正常HTTP字节匹配。新profile被动原版登录进入大厅，零JS错误；原版语言弹窗实际显示中文，未逐一验收全部新增界面。大厅存储提示图已定位并提取为588×339透明PNG；图像工具两次连接失败，没有安装替代图，嵌入图片文字仍有缺口。

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

后台物品新建补齐现有数据库必填默认值，复制保留完整模板并清除主键。物品编辑页可以读取当前草稿，检查素材路径、PNG chunk CRC、图标及 Show/Room/Game 帧网格，再预览原图。检查接口支持普通 CategoryID1..6 和套装13；头发检查 a/b 两种帽发状态，普通部件不要求套装的 game1.png。普通衣帽的250×312单图与表情的1000宽四格按原加载器区分；透明染色遮罩不因全透明而被判损坏。所有结果仍为 `renderingAccepted:false`：结构合格不能替代像素解码或游戏穿戴验收。

素材上传继续使用原有覆盖机制；模板管理、邮件发放和商城入口沿用现有服务。导入时使用唯一 TemplateID/Pic，保存字节摘要、原状态和删除范围，避免覆盖底包硬链接。`apps/api/scripts/workshop-wardrobe-smoke.ts --apply --hold` 是隔离测试流程，会创建本机私有测试账号，不能替代普通玩家的操作入口；重复执行时保留未回退账本。`--rollback` 仅回退本次记录且摘要吻合的素材/模板。

商城编辑页补齐A/B/C三档的Price1..3/Value1..3；BuyType=0时Unit表示有效天数，非0表示数量，币种/兑换材料由Price指定。旧禁用档哨兵值及Shop数值型IsBind/IsVouch保持兼容。新商品还需在“商城展示”(`/shop-show`)填写ShopId=Shop.ID与原ShopType栏目；TempID自动生成，CanBuy不能替代展示记录。男女栏目分开，按已有同类商品参照，不将Type当作CategoryID或NeedSex。

## 官网目录与普通服饰导入

`scripts/workshop-official.mjs` 从官网关联的匿名公开搭配站保存六类目录、原分页响应、请求摘要和新增/变更/移除差异。每次生成新快照；默认不下载图片。只有 `--targets=<目标时装.csv> --download-targets` 才获取唯一名称匹配目标的图标、Property8 分层 show/game，以及头发 a/b。同名歧义不自动选择；sourceTypeList=[0,1] 不证明正式服/怀旧服全量覆盖。目录更新时间不等于时装发布日期；HTTP200和PNG头也不等于完整解码或能穿戴。

```powershell
node scripts/workshop-official.mjs --previous=../../runtime/official-resource-reverse/diy-catalog.json --targets=../../wardrobe/目标时装.csv
# 明确目标需要新图片时追加 --download-targets；输出独立快照目录
node scripts/workshop-backup.mjs backup
# 从新快照的manifest规划下一批，替换三个占位路径；默认只读API并保存计划
node --import tsx apps/api/scripts/workshop-official-install.ts --acquisition=<snapshot/manifest.json> --journal=<runtime/new-batch.json> --backup=<current.dump.json>
# 继续同一账本，仅写本批独立覆盖与新模板，不重指定来源文件
node --import tsx apps/api/scripts/workshop-official-install.ts --journal=<runtime/new-batch.json> --apply --exercise
```

导入器复制实服同类别/性别模板的必填规则，覆盖官网明确给出的名称、属性、质量及图层；官网缺失的强化、等级和回收规则沿用本地源模板，不推断官方规则或价格。官网编号只保留为来源，旧客户端按编号首位选显示层，因此本地编号在对应类别的空闲范围分配；Pic和测试账号按批次隔离。原始PNG字节保留，上传后逐图HTTP摘要回读，先通过CRC/网格检查再创建可装备模板，随后等待XML和游戏缓存重载。

`--exercise` 用独立角色完成真实邮件领取、穿脱、TCP/WS重登与保存。邮件尚未领取时可以按精确附件/角色归属继续；来源摘要、已占用路径或模板变化会拒绝覆盖。已有账本只用于续跑，追加来源参数会拒绝；新目标使用新账本。导入与测试素材保留供游玩，失败时保留完整账本；工具不自动删除未知库存或恢复整库覆盖新进度。

新模板可在本机后台“物品”按中文名称搜索，在“玩家”向自己的本地角色永久邮件发放，游戏邮箱领取。普通商城全零价格会被既有购买逻辑拒绝，因此本批不伪造官网价格或修改购买规则。男女部件分别限制穿戴，女装领取进男性库存也不能直接穿戴。

`research/client/WorkshopOfficialWardrobeProbe.as` 与 `scripts/workshop-official-render.mjs` 使用原客户端类、独立PlayerInfo和私有headless Chromium，读取ShowCharacter/RoomCharacter/GameCharacter、染色和头发a/b；不发送换装指令，不操作桌面或现有浏览器。生成原组件画面仍需检查实际截图、精确TemplateID/Pic及加载证据，不能称为自然实战、鼠标操作或用户接受验收。

```powershell
node scripts/workshop-official-render.mjs --journal=<runtime/new-batch.json> --sex=m
node scripts/workshop-official-render.mjs --journal=<runtime/new-batch.json> --sex=f
# 实际检查截图后，在私有账本记录 renderingAccepted=true 与明确的验收范围/证据
node scripts/workshop-official-deliver.mjs --journal=<runtime/new-batch.json> --user=<自己的本地角色ID>
```

发放沿用GM永久绑定附件，每件独立邮件；邮件保留既有720小时有效期，请在期限内领取。成功账本重跑只报告alreadyDelivered，不重发，也不因用户随后换装或获得金币改写原成功记录。发送前保存pending和已有邮件ID；未知结果只核对唯一新邮件/精确附件，无法确定时保留账本并拒绝盲目重发。

本批截至2026-10-11已实际安装14个官方部件、98张PNG，均通过真实穿脱/TCP和WS重登保存。原AS3的Show两帧、Room四帧、Game选定姿态、图标与2/3层染色已检查32张截图；完整自然战斗及动画未新增验收。全部14件已发到本地角色「1」的邮箱，7男/7女；原角色外观、金币和点券不变，女装仍受性别限制。其余13个目标未在公开目录命中，不能称为官方新衣服齐全。每次刷新保存独立目录与差异；本日最后一次全目录回读仍为4324条，新增/变更/移除均0。

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

验证恢复会建立独立的`workshop_restore_*`数据库，不覆盖原`ddtank`。停止当前栈后，可运行`node scripts/workshop.mjs start --restored=完整的.dump.json路径`启用该副本。入口核对dump SHA256、成功恢复证明、严格副本库名、现有PG集群及真实连接库；首次核对六表指纹，匹配后写本机私有绑定。后续使用同一入口可保留合法的新存档，仍核对备份/证明/绑定，但不要求新进度等于旧备份。副本不自动迁移或重新播种。

`status`显示databaseName，`backup`跟随正在运行的所选库并在manifest记录sourceDatabase。正常停止后默认`start`即切回原库；不删除、重命名或覆盖任一存档。缺少/损坏备份、证明或绑定时明确拒绝启用，不偷偷退回原库或创建空库。数据库备份不包含素材、运行时、上传覆盖及私有配置，需要另做本机私密保存，不能上传公共仓库。

备份使用原生 pg_dump；verify 先校验 SHA256，只恢复到随机新库，六组关键表行数和全行摘要必须匹配。正常 `ddtank` 数据库不被覆盖。备份仅含数据库，上传素材、公钥覆盖、密钥、配置和源码需另外私密保存。

非套装自定义商品烟测在`apps/api/scripts/workshop-custom-shop-smoke.ts`：`--run`新建独立普通账号与唯一商品/商城/展示键，通过正常HTTP/RSA/WS验证零余额拒购、支付37Money取得7天绑定武器、重登保存与精确回退；`--rollback`恢复既有账本，`--verify`只读核验已回退结果。已有账本时`--run`明确拒绝重做。示例复用原Pic，不写素材；保留测试账号、任务副作用及逻辑删除的购买行，协议通过不代表新增外观已渲染验收。

恢复副本已实际启用、创建普通角色并正常进入协议大厅，同一`--restored`入口重启后背包和余额保存；副本的新备份又恢复到第二个独立库。默认入口已切回原库，副本专用账号不能登录原库。原库重启时API的排行榜刷新会正常重算`AddDayGP/AddWeekGP`；本次唯一差异为测试角色这两个值0→1，已按全表摘要精确核实，因此只宣称原库未覆盖，不宣称它在正常服务启动后全行不变。

本轮窄回归：后台物品/价格字段7项、中文4项、服装表单2项，启停与恢复7项；后台构建和后台/API/数据库类型检查通过。较早的素材合并、Flash覆盖、套装检查、卡奖励与fight验证保留在外层记录。本轮曾遇到并行Vitest无结果挂起，受控结束后串行通过；未把挂起算通过。完整近年服装、所有副本、物理异机连接仍不能据这些检查推断通过。

完整项目已在同机新目录冷启动验证：复制68,074个文件、约2.00GB原始内容，重锚1,276个内部junction与186个依赖启动包装；包含已安装的工作树资源、私有配置和停止状态的PG集群。七个服务进程及实际PG目录属于新根，普通HTTP/RSA/WS大厅登录、背包/余额/Style保持以及选定真实素材和Ruffle字节匹配通过。全新Chrome profile被动加载原版SWF，实际大厅背景可见，内嵌未翻译存储提示仍显示；139个HTTP响应中134个200、周活动配置4次404和favicon一次404，后两文件在原部署也缺失。零JS运行时异常，但不把周活动或本次新玩法/服装显示算通过。副本正常停止后原项目恢复默认运行，六表全行摘要与复制前新备份完全一致；物理异机与空白机器安装未由这次同机迁移证明。
