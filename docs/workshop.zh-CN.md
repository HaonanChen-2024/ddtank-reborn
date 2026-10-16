# 本地 Workshop 运行与内容扩展

## 地形边缘的弹坑遮罩

`node scripts/workshop-literals.mjs verify --crater-mask` 只读检查，`install --crater-mask` 安装可选客户端兼容修复。现用 Ruffle 下，原 `phy.maps.Tile.Dig` 的 `BlendMode.ALPHA` 步骤可能让整圈焦边写入透明天空；客户端碰撞也读取这张地形位图。修复以原矩阵将挖坑后的地形绘入局部透明遮罩，再用 `copyPixels` 将遮罩与焦边透明度相乘。原挖坑 ERASE、坑大小、最终焦边混合方式、地图坐标及服务端物理规则保持。

此开关只改 `2.png` 中 `Tile.Dig`，保留已启用的中文、活动状态和兑换补丁；之后省略开关也会保留已安装的修复。安装前保存当前覆盖文件及 `client-overlay-literals.json` 的成对备份，在无人在线时部署并核对 `/flash/2.png` 实际响应。已有资源路径由 API 按当前文件读取；客户端必须重新加载，已打开的旧对局不会被热修。通用 `rollback` 撤回整套已归属覆盖，不只撤本项。

原/候选实际 `Tile` 类的隔离 Ruffle 对照覆盖透明天空、斜坡、重叠弹坑及非整数坐标：原版会在天空新增被客户端判为实体的像素，修复后为零。该组件检查不代替完整自然对局、全部地图和所有弹种的验收。

## 战斗道具消耗与临时奖励移交

战斗袋中的道具消耗沿用原 `RemoveItem` 语义，将对象标为不存在。已有数据库 ID 的道具由战斗袋保留删除待保存记录，即使装入战斗袋后已发生一次自动保存，后续消耗也会写回原记录；全新临时道具不会因此插入数据库。保存失败时保留待保存记录，重试仍更新同一 ID。该修复不回写历史异常记录，不改变怒气道具效果、数量或战斗规则。

临时奖励领取（协议108）与宝箱奖励取回使用 `TakeOutItem` 表示移交，保持进入正式背包或溢出邮件的物品有效。隔离数据库测试覆盖中间保存、消费、未用道具返包、保存失败重试与两类奖励移交；原客户端完整自然对局及部署后存档仍须另行验证。返包自动合并到已有堆叠的持久化边界仍待单独修复和验证，不计入本次返包覆盖。

## 签到持久化

游戏协议 `13/type5` 在同一数据库事务中保存签到去重记录与 `DailyLogList`；先锁定本人角色行，再取当前 UTC 日期并判断当日是否已签，避免排队跨月后用旧日期回写日历。首次插入或已有日历更新失败时，两者一并回滚，玩家可以重试；重复签到仍保持原来的静默无新增记录行为。此处不改变 UTC 日期、累计天数规则或奖品。

协议 `90` 累计签到奖励先取得现有持久化锁和必要的战斗结算屏障，再锁定同一角色行，在锁内取当前 UTC 时间并复核本月累计天数。领取标记与新奖励的生效时间共用这个时间，排队跨月后不会按锁前的旧月份发奖。领取标记、待保存的背包变更、货币与溢出附件/邮件在同一事务中提交，SQL 或发奖失败时全部回滚；提交后才完整发布在线内存并发送原通知。发送失败不撤销已提交奖励，也不能通过重试重复领取。月份、档位、性别、绑定、有效期及现有溢出邮件 Type12 保持；不限制原来可领取的房间状态，不增加90回复包。

隔离测试覆盖并发唯一领取、发奖与邮件失败、提交至内存发布期间的自动保存、提交后发送失败及经验升级。独立 PostgreSQL 连接还覆盖日历首读、签到与读取并发、排队跨月的签到和累计奖励资格；原客户端累计签到按钮和现役部署仍须另行验证。

## 日历中的个人活动领取状态

可选 `--activity-state` 覆盖让登录后的原日历请求使用 `UserCalendar.ashx`。新接口校验原客户端的 `selfid` 与 MD5(GameKey)，绑定有效登录会话和账号；返回原签到字段及本人一次性免费活动（HasKey3）的领取状态，响应不缓存，登录前公共 `ActiveList` 保持原样。新接口及兼容旧入口 `dailyloglist.ashx` 均与游戏签到锁同一角色行，在事务中共用日历规范化逻辑；正常路径在锁内取日期，防止刷新覆盖刚完成的签到、并发首读重复插入或排队跨月后回写旧月。

日历 SQL、事务开始或提交失败时，在事务外返回带 `nowDate` 的压缩 `Fail!` XML；不把已中止事务带到通用未压缩错误响应。旧入口参数与原 XML 字段保持，没有新增鉴权或未知角色拒绝规则；无角色行可锁的旧请求不属于并发保护保证，也不清理历史重复日历。

Windows 下可用 Node 24 运行 `node scripts/workshop-calendar-postgres.mjs --execute` 验证独立连接的实际 PostgreSQL 行锁。脚本只创建本次 UUID 空 cluster 和 template0 测试库，使用独立的 55439 端口与随机凭据；不读取应用配置、不启停应用栈，结束后核对归属、删除自有测试库并关闭自有进程，保留测试数据目录及日志。普通 API 回归不自动启动该检查。此验证不代表原客户端完整验收；现役累计奖励 UI 仍缺少独立已领取状态和失败补领入口，ACT-01 尚未完成。

普通活动动作取得钱包锁后，仍可能等待账户或角色的 `FOR SHARE`。该分支保留原鉴权取时，在全部 owner 等待结束后再取业务时间，供商品/背包日期凭据、每日次数、上下文、历史和响应共用。月光旧商品凭据跨日后拒绝，失败不改变钱包、状态、回执、物品或邮件；刷新凭据后可按新日购买，同 UUID 重放不再发奖。旧网页寻宝按新日重置每日次数，同日购买保持原价和交付。A07阶段独立检查含11例、12个真实行锁等待场景（账户与角色等待分别验证），日志位于 `runtime/moonlight-shop-followup-20261016/`。此修复不扩充两商品目录，不定义个人限购或排行奖，也不改公开字段；源码仍需正常部署及原客户端验收。

A14拼团在钱包锁后还会等待账户、当前角色及完整成员的 `FOR SHARE`。拼团动作保留原鉴权取时，先在钱包锁内复核团长保存的成员集合，在最后成员锁返回且资料完整后统一取得业务时间；上下文、令牌/到期判断、新角色首次状态、每日次数、历史、消费累计和响应共用该时间。锁等待期间过期或跨UTC日的旧令牌沿用原409拒绝，钱包、状态、回执、物品和邮件不变；刷新合法令牌后仍可正常三人成团。同UUID的两条重放入口在owner等待及回执确认后刷新当前投影时间，不修改原回执或重复发奖。锁次序、成员变化重试、价格、30分钟期限、奖励、鉴权规则及公开请求/响应结构保持。

A14批次的独立PostgreSQL检查为17例、18个真实行锁等待场景、4个独立连接。新增A14用例在旧实现下4败13过，修后17/17；A14单元与隔离HTTP回归29/29及API类型检查通过。测试分别观测账户和非actor成员的阻塞SQL/PID，并用另一连接逐个NOWAIT确认钱包已锁；覆盖两条未到期成团对照、跨日缺状态角色重试及已提交UUID的过期投影。首次夹具缺语言对象/角色日期默认值干扰，以及随后错误码期望400而原拼团实际409的失败日志均保留，没有为测试修改产品错误码。每次测试均核归属后删除自有UUID库并关闭55439进程，日志位于 `runtime/forthright-owner-wait-20261016/`；未读取现役配置、连接现役DB或启停应用栈，源码部署与原客户端验收仍待完成。

客户端复用原活动对象与原按钮逻辑，不替换活动数组；同一账号保留刚领取成功的状态，切换账号时清除旧的HasKey3状态。迟到的其他账号响应仅结束自己的加载器，不调用当前日历的业务回调。兑换码、定向发放和共享码活动的领取规则不在此补丁中重定义。

新API与客户端覆盖需一起部署。正常停止本地服务后运行 `node scripts/workshop-literals.mjs install --activity-state`，正常启动后用 `verify --activity-state` 回读。开关自动保留已有中文及 `--activity-response` 修复；以后省略开关也会保留账本中已启用的功能。通用 `rollback` 会撤回整套字面量覆盖；只撤本次升级时，应恢复升级前精确备份的覆盖文件与对应账本，不混用不同阶段的文件。

真实原客户端已分别验证已领取角色的灰色按钮与未领取角色的可用按钮，网络回包、原模型和截图一致，原个人资料初始化正常。初版覆盖曾因AVM2回跳缺少Label失败，精确恢复后修正并重新验收；静态字节码和单元测试不能替代此运行检查。此项不代表日历全部外文位图已翻译，也不覆盖整套跨账号界面操作或其他奖励领取方式。

## 任务凭证赠送的跨日锁等待

A13任务凭证赠送在双钱包锁后仍需等待赠送者账户和收件角色/账户的FOR SHARE。现在保留原鉴权取时，在最后收件资料锁及有效性检查后统一取得业务时间，用于日期绑定的全量token、双方状态、收件acquiredAt、history和响应。等待中跨UTC日的旧token按原规则409拒绝且五表不变；刷新新日token后同一永久凭证和失败UUID可正常提交。已提交UUID在owner及回执确认后刷新当前日期投影，即使收件人已改名仍可恢复，原历史与交付不变。凭证永久期限、单次转赠、个人资格、daily计数、双钱包锁序、费用、鉴权与公开契约保持。

本轮隔离PostgreSQL的22例在旧源码下18过4败，修后22/22、23个真实行锁场景、4独立连接；新增三种锁跨日反例、同日对照和改名后跨日重放。另A13纯规则与隔离HTTP14/14、API类型检查通过。HTTP基线原7败来自禁止任意state字段的旧断言与现有雪场公开枚举不符，现按三个明确公开路径检查，原始存档、seed和卡片origin继续禁止泄露，原失败日志保留。测试均验证自有UUID库归属并清理数据库/55439端口，证据位于 `runtime/firstrecharge-owner-wait-20261016/`。未读取现役配置、连接现役DB或启停应用；正常部署及原客户端验收仍待完成。

## 全目录服饰批次与来源隔离

`scripts/workshop-official.mjs --all --catalog=<catalog.json>` 可以为官网六类 DIY 快照建立完整清单；它不代表官网整个游戏的资源全集。下载需再指定 `--download-all --batch-size=12 --offset=0`，批次保留独立目录及失败回执。用固定快照推进 offset；`--resume=<旧批次目录>` 在新目录内仅复用路径、大小和 SHA256 校验成功的文件。清单按精确来源 ID 保留同名物品，已装和缺失、重复素材、当前不兼容分开统计。下载及 PNG 头检查均不等于实装或画面验收。

`apps/api/scripts/workshop-official-install.ts` 继续通过已鉴权的本地管理接口工作，默认只做 dry-run；`--acquisition` 用于官网目录，`--reference-acquisition` 用于参考服纯视觉清单，两者互斥。参考清单只接受来源 ID、名称、类别、性别、路径、图层标志与描述，保留 `referenceId`，数值继承本地同类别同性别基础模板，不带入私服装备属性。资源需精确路径及哈希匹配，通过原有 wardrobe-check 后才建模板。支持类别 1–6 和套装13，武器不走此导入器。

套装使用装备槽11、Style下标7，必须另有每层独立的 `game1.png`；不能套用 `CategoryID-1` 的普通衣帽槽位。中性套装保留 `NeedSex=0`，图片按原客户端取 `f/suits`，与角色性别无关。本地基础模板显式选择中性13100、男13841、女13842，并核对实时类别/性别及摘要。当前一条回执只拥有一组物品/邮件ID，中性套装的协议测试分派女角色并记录覆盖范围；男角色的无写入组件显示通过不能冒称男角色领取穿脱已验证。套装本地ID保持13前缀，短身份段最多15字符，整个Style仍限制200字符。

新资源 Pic 使用短名称，来源 ID 留在私有账本中，避免同时穿戴后超过原 `Style varchar(200)`；发出穿戴协议前也检查组合长度。每批使用新账本，恢复只读该账本。正式交付前应完成男女隔离角色的领取、穿脱、TCP/WS 重登保存、原显示组件及战斗角色图层核验；用户邮件发放仍要求已完成视觉验收的账本。保留原件与旧资源，不修改角色等级或基础规则。

背包图片文字支持有实际墨迹边界检查的水平微调，标题与属性栏统一对齐、小按钮减少描边以避免缩字。`scripts/workshop-bag-layout.mjs install --bag-label-alignment` 统一隐藏装备标签距复选框的偏移，并保留原有结算标题覆盖及回退备份；未选择该选项时旧布局输出不变。男女主页面已做实际渲染检查，其他子页及全界面中文化仍需逐页验收。

## 继续修改中文文字

客户端字典由 `research/i18n/zh-CN-overrides.json` 与 `scripts/workshop-language.mjs` 管理，当前覆盖3461键/3477物理行。3503个原键中的42个非正文值（字体、格式、空串、触发码等）保持；所有正文已有中文覆盖。新增翻译必须对应原键，保持占位符、CRLF、BOM和重复行；`verify` 只核验，`install` 保留上一次部署备份。图片文字单独处理，字典覆盖不代表原窗口全部按钮已验收。

本次保留全部359个既有中文键，新增2415个经过精确同键、占位符、数值、HTML和控制标记检查的中文条目，另按本地语义补译9键。参考候选中的19处VIP权益、货币绑定、宠物等级、活动状态等含义差异已排除，其中10键仍需核对真实调用或服务端行为；未导入参考服装备属性或奖励配置。该批静态审阅重点对照839个候选，不代表每个词条或全部页面已通过语义、布局及功能验收。

核心 SWF 的已知越南语/葡萄牙语常量另由 `research/i18n/zh-CN-literals.json` 与 `scripts/workshop-literals.mjs` 管理。工具沿用现有 ABC 字符串补丁器，仅写 `runtime/client-overlay`，保留当前部署的 RSA 公钥和其他字符串、方法代码及位图。当前三个文件共替换 42 个常量位置：`2.png` 34 个、`3.png` 5 个、`DDT_Loading.swf` 3 个；称号译名为本地语义翻译，不能用于推断官方时装名称或素材映射。

安装或回退 SWF 覆盖后需重启服务以重建静态文件索引；在源码根目录依次执行：

```text
node scripts/workshop.mjs stop
node scripts/workshop-literals.mjs install
node scripts/workshop.mjs start
```

`node scripts/workshop-literals.mjs verify` 核对当前补丁与备份哈希。回退时将 `install` 换成 `rollback`；只恢复账本拥有的覆盖文件，原 vendor 与仓库中的二进制均不写入。自行修改过部署文件时工具拒绝覆盖；更新该批译文前先回退，保留其他自定义内容。

可选 `--activity-response` 修复旧 Calendar 活动领取回调：该消费者原来按大写 `True` 比较，而现有服务器成功值是小写 `true`。工具精确验证 `CalendarManager.__activityLoadComplete` 的身份、方法摘要和指令，只追加一个小写常量并改变该比较的一处 operand；共享大写签到常量、其余47个方法和2524个其他SWF标签保持。服务器XML格式、活动规则和奖励不变；另一个直接显示XML的 `ActiveSubContent` 路径未纳入修复。

先运行 `node scripts/workshop-literals.mjs verify --activity-response` 查看候选；仅显式 `install --activity-response` 升级唯一现有覆盖账本，复用原备份并保留中文及RSA层。缺省命令会保留已启用效果；安装失败恢复当前文件和旧账本，完整 `rollback` 仍恢复该owner原备份。联合9项窄测试和真实配置离线verify通过，覆盖已安装、正常重启及HTTP摘要回读；原活动页面领取/按钮禁用、邮件附件与重复拒绝尚待运行验收。

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

普通活动的 `ActivePullDown` 将领取记录/激活状态、全部附件与邮件放入同一现有事务，邮件通知在提交后发送。空池、无适用奖励、无效模板及不能按当前邮件能力交付的配置返回已有失败码，不消耗领取机会；同账号领取多个唯一激活码也会序列化核验。普通奖励按原MaxCount拆堆，每封最多五附件、币种仅首封，保留全部数量。现有接口、成功XML、返回码、币种映射及装备模板属性保持。当前不支持非零强化/合成奖励，明确拒绝，避免悄悄丢弃配置字段。最终34项内存测试及相同34项独立PostgreSQL/postgres.js测试已通过，包含跨封拆堆、真实约束/触发器导致的邮件中途失败与全量回滚；API类型检查及此前64项组合回归通过。原客户端活动页面尚待验收。

`research/activities/local-starter.json` 定义一项“本地启程补给”（100001）：每个角色免费领取一次，按原邮件流程发送现有11904经验药水一瓶，不直接升级、不改变副本门槛、装备属性或币种。`scripts/workshop-starter-activity.ts` 默认只读verify，显式install仅新增自有Active及Award两行；核对运行session/原生数据库绑定、原33/310行全列指纹和四表主键/冲突。重复安装保留已有领奖进度；配置、原行或自有行变化时拒绝覆盖。journal在事务提交前独占写入并同步；提交结果不确定且缺行时保留现场并拒绝续写，不自动补偿删除。12项隔离测试及运行库首次安装、重复零插入、正常重启后verify通过；一次重复CLI拒绝原因未确认，随后直接事务和CLI回读通过且数据保持。专用角色的原Calendar公开控制器已实际成功领取，中文反馈、邮件、单瓶附件进入背包、重复拒绝且不增奖励、原返回大厅和正常WS重登保存通过。第一次业务运行因私有探针误读EmailInfo字段而停在收件前；后续凭原证据恢复现有唯一邮件，未重发、重置或使用药水，等级/外观/币种不变。原按钮点击/私有回调及被Flash存储提示遮挡的页面视觉仍待验收。ActiveList未传已领奖状态，新登录按钮仍可领但服务器正确拒绝，不能称重登灰按钮通过。

活动服务器反馈、异常提示及新发奖励邮件正文已改为简体中文，仅改展示字符串，成功/失败码、XML、RSA与原事务不变。复用34项事件测试补充中文成功/重复响应、真实邮件正文与故障回滚断言，34项及API类型检查通过。正常重启已加载该显示补丁；客户端原按钮点击/私有回调仍待验收，已有邮件不批量改写。

```powershell
node --import tsx scripts/workshop-starter-activity.ts verify
node --import tsx scripts/workshop-starter-activity.ts install
# 新增后正常重启API缓存，并使用全新客户端连接
```

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

`research/client/WorkshopOfficialWardrobeProbe.as` 与 `scripts/workshop-official-render.mjs` 使用原客户端类、独立PlayerInfo和私有headless Chromium，读取ShowCharacter/RoomCharacter/GameCharacter、染色和头发a/b；不发送换装指令，不操作桌面或现有浏览器。每张服饰组件截图前后必须取得新鲜、连续、同一job与物品/原色或染色/帽发/隐藏状态的观察；过期、换项或画面离开最上层时拒绝记为成功。计数和资源加载完成不能替代这道截图绑定检查及人工图像检查，也不能称为自然实战、鼠标操作或用户接受验收。

截图前以本条 `official-frame-ready` 的事件位置为边界，最多等待1500ms取得其后的新观察；此前上一项的失效观察不用于判断新画面。边界之后的失效、错误或身份不符仍立即拒绝，不能被后续正常观察覆盖；原1500ms新鲜度及截图后检查保持。

发型A/B的合成分支由原 `PlayerInfo.getHairType()` 读取可见帽子的 `Property1`，不是独立图层参数。Category3克隆在A任务使用原普通帽子1102/1202，在B任务使用透明默认帽子1101/1201，并断言头部基线、发型Style和真实分支一致；截图前再次核对 `componentHairType`。旧证据若只加载独立B层、合成仍为A，不能算完整A/B合成验收，须保留原记录并补测。

套装额外显示原色、仅clone染色和隐藏后普通服饰恢复，每套3组画面；正常分支6及备用game1分支7各绘制39帧。分支7是手动原组件调用，不代表真实低血量事件会触发切换；clone的Colors第8段渲染也不代表游戏染色界面支持套装。完整对局、实际状态切换及动作连续性需另验，`gameplayAccepted` 保持false。

```powershell
node scripts/workshop-official-render.mjs --journal=<runtime/new-batch.json> --sex=m
node scripts/workshop-official-render.mjs --journal=<runtime/new-batch.json> --sex=f
# 实际检查截图后，在私有账本记录 renderingAccepted=true 与明确的验收范围/证据
node scripts/workshop-official-deliver.mjs --journal=<runtime/new-batch.json> --user=<自己的本地角色ID>
```

发放沿用GM永久绑定附件，每件独立邮件；邮件保留既有720小时有效期，请在期限内领取。成功账本重跑只报告alreadyDelivered，不重发，也不因用户随后换装或获得金币改写原成功记录。发送前保存pending和已有邮件ID；未知结果只核对唯一新邮件/精确附件，无法确定时保留账本并拒绝盲目重发。

协议安装测试与最终发放共用完整分页读取，再按收件人和附件模板精确核对。管理端通用 `q` 会匹配所有列，例如角色51也匹配邮件类型51，不能只读取第一页500封。分页总数变化、缺页、重复ID或多个匹配附件均停止；安装测试发送前也保存pending，恢复时核对已有发送，不重发。补丁前的未知发送没有pending基线，必须先以真实邮件/附件记录核实并绑定原账本。

本批截至2026-10-11已实际安装14个官方部件、98张PNG，均通过真实穿脱/TCP和WS重登保存。原AS3的Show两帧、Room四帧、Game选定姿态、图标与2/3层染色已检查32张截图；完整自然战斗及动画未新增验收。全部14件已发到本地角色「1」的邮箱，7男/7女；原角色外观、金币和点券不变，女装仍受性别限制。其余13个目标未在公开目录命中，不能称为官方新衣服齐全。每次刷新保存独立目录与差异；本日最后一次全目录回读仍为4324条，新增/变更/移除均0。

## 中文客户端

副本列表累计配置 `research/i18n/roomlist-art/zh-CN.json` 覆盖13张位图的18处固定文案，保留先前六处替换。新增12处包括副本远征、房间列表、个人信息及房间操作按钮；7个确切原JPEG标签通过已等待的解码转换为无损PNG，校验原SWF、标签、类名、像素和成品摘要，原帧、点击区、动态数值及字区外像素保持。`node scripts/workshop-bag-art.mjs verify --roomlist` 做离线核对；`install --roomlist` 使用原独立账本部署。标题底纹柔化与原图标遮挡处的文字清理需在原客户端复测，离线预览不能作为整页、按钮状态或副本游玩验收。

列表底部滚动提示使用独立的 `research/i18n/zh-CN-moving-notifications.json`，包含34条完整中文提示。`node scripts/workshop-language.mjs verify --notifications` 只核对；`install --notifications` 写入 `runtime/client-overlay/ui/vietnam/movingnotification.txt` 和独立账本 `client-overlay-notifications.json`；`rollback --notifications` 回退该覆盖，保留两套字典。该模式与 `--server` 互斥，校验原文件 SHA，保留原 UTF-16LE BOM、CRLF 和末尾空项，原逐行解析及15秒轮播逻辑不变。更新时保存旧内容及账本，遇到外部改动拒绝覆盖；原客户端文件与 vendor 不写入。首次新增覆盖路径后须正常重启服务以更新静态索引，再核对完整 HTTP 响应及原客户端显示；CLI通过不等同于整页验收。

普通客户端词典的安装与回退：

```powershell
node scripts/workshop-language.mjs verify
node scripts/workshop-language.mjs install
node scripts/workshop-language.mjs rollback
```

安装配置中指定的字典键，保留 CRLF、BOM、重复键、顺序和格式占位符，原版客户端及原字典不变。回退校验账本，遇到用户另外编辑的覆盖文件会保留。新 Noto Sans SC 字体遵循 SIL OFL，许可在 `apps/web/public/fonts/OFL.txt`；来源固定为 [Noto CJK Sans2.004](https://github.com/notofonts/noto-cjk/tree/523d033d6cb47f4a80c58a35753646f5c3608a78)。字典不能翻译 SWF 内嵌位图按钮或数据库中的旧物品名称。

背包图片文字由 `research/i18n/bag-art/zh-CN.json` 和 `scripts/workshop-bag-art.mjs` 单独处理，覆盖41张位图、72处文字；“隐藏”标题来自 `coreii.swf` 的另一张图片，使用 `hidden-controls.zh-CN.json` 和独立账本。隐藏装备选项的布局由 `scripts/workshop-bag-layout.mjs` 处理。两个工具只写部署覆盖，保留原资源和备份；现有覆盖或备份摘要变化时拒绝覆盖。位图只修改审核过的文字矩形，保留尺寸、其他像素及非目标 SWF 标签；XML默认只修改 `bagAndInfo.xml` 的复选框布局，其他100个压缩条目原字节不变，原事件继续使用。

服务器喊话和提示使用独立词典。`node scripts/workshop-language.mjs verify --server` 校验完整原词典、平面覆盖和按原文件SHA绑定的重复键变体；六个重复键的13个不同原值分别保留占位符，不以最后一行替代其他变体。当前覆盖3622键/3836物理行，其中54个内部附加键含38个原词典缺失的副本对白键。附加键仅接受原 `Workshop.Events.*` 或规范的 `Workshop.Pve.*` 命名空间；不放宽碰撞、分隔符、格式与回退校验。`install --server` 写 `runtime/server-language.txt`，保留独立账本及备份历史；`.env.workshop` 的 `LANGUAGE_FILE` 指向该文件，正常重启后Game才加载。安装器不自动重启，不改怪物行为或数值，实际喊话仍须原窗口验收。

仅 `--server` 模式可另外读取可选的 `research/i18n/zh-CN-server-additions.json`，格式为平面映射，如 `{"Workshop.Events.Example":"反馈 {0}"}`。它供没有准确原词典键的本地服务端显示文字使用：键必须位于 `Workshop.Events.` 命名空间，不能含冒号、换行或TAB，也不能与任一原键或override键重名；值必须为非空字符串，不含CR/LF/TAB。合法条目以CRLF追加到原覆盖结果之后，原词典文件不写入，原override未知键与占位符校验保持。未提供该文件时输出及元数据沿用旧行为；有新增条目时 `keys`、`translatedRows` 包含新增条目数，并另报 `addedKeys`。验证不写文件，安装仍沿原账本/哈希/备份与回退规则，客户端和滚动提示模式不读取此文件。附加词典只改变已有消息中的显示文本，不增加Game90回执或日历字段；新公开领奖契约仍须单独确认。源码和隔离安装器检查不等同于已部署或原客户端验收。

可选 `ITEM_NAME_OVERRIDES_FILE` 继续由API和Game共用模板翻译层读取，严格格式为 `{"schemaVersion":1,"table":"Shop_Goods","names":{"模板ID":"显示名"}}`。现有23个名称保持，只有11041按已核对的碎片juniorpike/武器7026-pike资源改为“初级真·远古竹枪碎片”；13689保留本地译名“龙骑士套装”。全量道具名称和说明由下面的通用显示覆盖提供。此文件仅覆盖内存Name，不改模板、库存、历史邮件或属性；未知格式和缺失文件明确报错。

名称、描述和副本覆盖的绝对路径须同时传给API和Game，经原Workshop启动器正常重启后重建内存模板和缓存，客户端重登读取新模板。移除配置或恢复旧覆盖再正常重启即可回退，无需数据库翻译导入。每日彩蛋、贵宾、签到、等级礼包及世界首领的新提示和邮件标题使用中文；历史邮件、玩家姓名、公会名和自定义房间文本保留。

### 物品描述与任务文字

可选 `TEMPLATE_TEXT_OVERRIDES_FILE` 在共同翻译层提供28张资料表的显示字段内存覆盖，不写数据库。严格格式仍为 `{"schemaVersion":1,"entries":[{"table":"Quest_Condiction","rowId":"341:1","text":{"CondictionTitle":"赢得4场战斗"}}]}`。允许字段以 `packages/db/src/translations.ts` 的白名单为准，仅包含名称、说明、任务/成就正文、活动宣传等显示文字；效果、奖励、条件参数、日期和阈值均不允许。普通地址使用正整数ID；任务条件使用完整 `QuestID:CondictionID`；套装部件使用完整 `ID:ContainEquip`（保留逗号列表），同ID的不同部件不会串译。仅DailyLeagueLevel允许既有Level0，仅Shop_Goods允许五个既有虚拟奖励负ID。未知表/字段、非法或重复地址、空白文字和缺失文件均报错。此覆盖优先于同列数据库翻译及旧物品名覆盖；未覆盖字段保留，空Objective等不填造。

`research/i18n/zh-CN-template-text.json` 当前15350条/25668格，另有独立副本覆盖1208条/1912格。道具seed共7640行，7638行非空名称及4261格非空说明均已覆盖，另两行原本为空，保持空值。范围还包含任务、成就、宠物/技能、卡片/套装、公会徽章、分类、军衔及活动详情。按当前seed语义翻译，原版资源只有在身份和关键字段匹配后才采用；不依相同ID搬用另一版本的奖励或效果。技术型号、快捷键、玩家署名、URL和格式标记有逐项例外；数字、占位符、HTML/着色标记及原换行保留。温泉只翻译已知默认房间文本，玩家自定义内容保留。

部署时把此JSON的绝对路径配置为 `.env.workshop` 的 `TEMPLATE_TEXT_OVERRIDES_FILE`，原启动器会传给API和Game。空闲时正常重启，两端共同加载；客户端重登读取原普通及压缩XML。CLI校验、隔离API/Game加载、部署回执与原窗口字体/布局/交互验收分别记录。原件、旧覆盖和全部证据保留；这些翻译行数不代表新增游戏物品，也不代表原SWF、图片或全部游戏流程已完成验收。

### 普通副本显示文字

可选 `PVE_TEXT_OVERRIDES_FILE` 复用 API 与 Game 的模板翻译层，默认关闭。格式为 `{"schemaVersion":1,"entries":[{"table":"NPC_Info","id":2001,"text":{"Name":"先锋蚁"}}]}`；仅允许 `Pve_Info.Name/Description`、`Mission_Info.Name/Title/Description/Success/Failure` 和 `NPC_Info.Name`。未知字段、表、显示列、非法 ID、重复行或错误文件会明确失败。配置只覆盖内存中指定的显示列，未覆盖行、既有数据库翻译和 `ITEM_NAME_OVERRIDES_FILE` 保持；不会改写玩法数值、模板、库存或邮件。API 的 `LoadPVEItems` 也按原翻译层处理 `Pve_Info`，与 Game 保持一致。

`research/i18n/zh-CN-pve-overrides.json` 当前提供1208条/1912格副本、关卡及怪物显示文字；使用当前版本名称及关卡语义，原玩法数值、ID、奖励和原模板保持。28个generated脚本中的84处缺失台词调用已改为38个稳定语言键，未改AI分支或时序；其中四个旧键没有可恢复原文，采用明确记录的新写中文场景对白，不冒称恢复原台词。三个显示覆盖和服务端词典须正常重启后同步加载；实际副本和怪物界面仍按原窗口证据验收。

大厅使用 `hall.zh-CN.json` 和 `--asset=hall` 的独立账本。原14张fmt5位图（12个建筑标题、频道与签到）基础上，新增原存储窗口正文id7及实际确定按钮id10的19处文字，默认共16张图片，其余331个SWF标签保持。存储正文保留原许可选择语义，右侧“允许/拒绝”明确为示意，不代表浏览器已授权。原入口、事件和动画继续使用，字区外像素不变；农场、独立活动入口和其他工具栏图片仍待处理。

大厅支持可选 `--background=<PNG路径>`，只接收配置中已审阅的1000×600背景摘要，并将图像内容写入原tag21/id12。夜景模式绘制13处标题、清空频道图片的一处重复文字，让底图已有的中文“频道”显示；频道框和命中对象保留。含新增存储图片后共改变17个图像标签，其余330个标签（包括ABC、SymbolClass、shape、sprite和动画）保持原字节。与上一夜景覆盖比较只新增id7/id10变化。背景作为同一hall覆盖的配置身份参与幂等安装、备份与回退；不带此参数仍生成原景标题及存储文字版本。主控已看存储位图1x/4x并核对正常重启后的HTTP字节；完整原窗口视觉仍待验收。

本批已实际核验字典2783键/2796行、六个HTTP覆盖及原件摘要，正常空闲重启和重复安装通过；真实玩家的等级、经验、外观及余额保持。男女原大厅与背包四张完整画面已查看，目标文字未观察到明显裁切或重叠；画面仍有农场、活动、反馈等外语图片，其他页面和点击行为未验收。一个女角色大厅尝试发生Ruffle WASM内存越界，保持相同部署的全新尝试通过，原因未确认，两次证据分别保留。已知weeklyinfo.xml与favicon 404也未计为修复。保存的AS3中15处译文竖线列表调用已静态核对，本批涉及13键；其他未覆盖的调用不能据此宣称全量契约通过。本次没有新增游戏操作、活动领奖、装备属性修改或在线回退验证。

```text
node scripts/workshop-bag-art.mjs verify --asset=hall --background=../../runtime/reference-server-research/hall-language-recon/hall-background-candidate.png
node scripts/workshop-bag-art.mjs install --asset=hall --background=../../runtime/reference-server-research/hall-language-recon/hall-background-candidate.png
```

聊天使用 `chat.zh-CN.json` 和 `--asset=chat` 的独立账本，限定当前/公会/私聊六个普通与选中按钮皮肤、三个频道标签，共9张fmt5位图。窄按钮仅对审核字墨范围采样填补，保留原边框、皮肤及alpha；透明标签仅改审核区域字形。其他433个SWF标签、ABC、动画、命中层和原XML位置不变。默认bag/coreii/hall的字墨阈值与横向采样不变，未知覆盖仍拒绝覆盖。单元测试保持synthetic，不要求LFS水合；真实chat资源hash/owner/标签/像素保护由 `verify --asset=chat` 独立核验。

```powershell
# 先确认没有在线玩家或进行中的对局，再正常停止本项目
node scripts/workshop.mjs stop
node scripts/workshop-bag-art.mjs install
node scripts/workshop-bag-art.mjs install --asset=hidden-controls
node scripts/workshop-bag-art.mjs install --asset=hall
node scripts/workshop-bag-art.mjs install --asset=chat
node scripts/workshop-bag-art.mjs install --asset=hall-feature
node scripts/workshop-bag-layout.mjs install
node scripts/workshop.mjs start
node scripts/workshop-bag-art.mjs verify
node scripts/workshop-bag-art.mjs verify --asset=hidden-controls
node scripts/workshop-bag-art.mjs verify --asset=hall
node scripts/workshop-bag-art.mjs verify --asset=chat
node scripts/workshop-bag-art.mjs verify --asset=hall-feature
node scripts/workshop-bag-layout.mjs verify
# 回退时同样停服，将对应 install 换成 rollback，随后启动
```

API 在启动时建立资源索引，新覆盖需要正常重启及全新客户端连接才能核验。`node scripts/workshop-official-render.mjs --view=bag --sex=m`（或 `--sex=f`）使用账本指定的独立账号，调用原公开背包方法，保存完整背包画面、原控件边界及角色未变化证明；不模拟鼠标键盘、不修改背包。截图必须实际检查，不能把组件加载完成当成全部中文化或交互通过。帮助正文、奖励弹窗、项链培养及其他玩家页面仍有待办。

`--view=hall` 使用同一独立账号和原大厅加载流程，保存整页画面与角色未变化证明。它不打开背包、不发送建房或战斗指令，也不验收点击入口或自然对局；仍需逐张检查实际画面。

`--view=storage` 仅允许既有独立fixture 9/10，双端排除真实角色6及玩法fixture11。它保留自然存储窗口，必要时通过原 `ComponentFactory → SaveFileWidow.show()` 展示完整Frame；持续读取主大厅、窗口身份/几何、Self及cacheAble，截图前后新鲜观察不一致即拒绝。不点击、制造Frame事件、修改许可或调用保存；`allLayersLoaded=null`，NPC像素和中文需看整帧。静态门禁与编译、独立审查已通过。首次原运行只有client-loaded随后Ruffle AVM2 stack断言，0窗口观察/0截图；同源码/资源的大厅控制和随后存储验证均成功，无代码或Ruffle更换，首次失败根因仍未知。主控已检查fixture9原完整Frame：中文正文/真实确定按钮、原NPC、示意许可面板清晰且无裁切；截图前后门禁通过，cacheAble始终false、Self保持，三个临时文件清理。只验收该窗口视觉，不验收点击、许可持久化或所有页面。独立profile及原正常登录自身的网络行为仍存在，不称为完全无业务网络。

2026-10-11聊天覆盖已安装并正常空闲重启，六个HTTP覆盖文件摘要和原件保护、真实角色基线保持均已核对。男女原大厅整帧已实际查看：当前选中按钮、公会/私聊普通按钮与当前频道文字可见，未观察到裁切/重叠。全部9张离线候选与433个原tag的独立回读通过；公会/私聊选中状态及其他聊天频道的原客户端点击/视觉验收仍待完成，不能据此称全部聊天或大厅中文化。

`--asset=hall-feature` 仅将原 `ddthallicon.swf` 的精彩玩法主入口标题改为中文（bitmap171），保留原魔方、符号、动画、点击区域与其他396个tag。它展开的是原有子玩法面板，不会启用尚未实现的活动。原标题描边与魔方边缘已经合成，候选保留该混合边界；低分辨率位图放大仍可见像素阶梯。离线对比、原件/字区外像素保护、五种已有模式输出一致性及部署通过；七个覆盖摘要和真实玩家保护已回读。主控实际查看男女原大厅整帧，当前标题可读且未见裁切，其他外文仍可见。点击/展开行为尚未验收，不能据此称全界面中文化。

邮件页签候选使用 `node scripts/workshop-bag-art.mjs verify --asset=email` 离线生成；只处理“邮件列表、未读邮件、已发送”的两种状态，共六张原位图，配置为 `research/i18n/bag-art/email.zh-CN.json`。保留原背景、alpha、字区外像素、其他tag和ABC逻辑，使用独立email账本及未知覆盖保护。六图的1x/4x离线对比已检查；本批没有安装或重启服务，尚未验证原邮件整页、点击状态和其他邮件文案。不能据此声称邮件页面已全部中文化。

## 单人游玩与等级

副本开放状态在正常登录时按原 `GamePlayer.InitPvePermission / LoadPvePermission / SetPvePermission` 初始化与刷新。空值先建立内部 50 位初值，只有满足严格 `Grade > LevelLimits` 且原权限位允许更新时才写回；1/2/7/12/13 号副本从 Easy 开始，其他副本从 Normal 开始，已有较高权限和短串保持。该字段随原登录回包发送并经正常退出保存，不修改等级、经验表、门槛或直接补写存档。原版只在登录调用此刷新，邮件药水升级后需重新登录。

普通 Dungeon 的最终胜利在原 `PVE_STOPPED` 回调、回房之前解锁下一相邻难度：Easy→Normal、Normal→Hard、Hard→Terror。仅更新实际副本 ID 对应的权限位，要求整副本胜利且无后续关；仍参战的阵亡队友保留资格，离队、加载移除与机器人跳过。已有高等级权限或未知值保持，原版不发放下一档 Epic。通知与持久化沿用原 67 属性包和正常玩家保存，不另写奖励或数据库更新链。

9级满足蚂蚁副本（ID2、LevelLimits=8）的原等级条件。原客户端普通入口、首关地图1120与NPC加载已有独立复核，资源清单大小写错误造成的原自动失败保留；加载动画截图未完成配对。完整两关自然通关、翻牌和下一难度实际开放仍待验证，不能用结果事件单元测试代替。

退出竞技场的经验扣除按原 `GamePlayer.RemoveGP` 保级：先扣当前等级×12，最低保留1点；若扣除将失去当前等级，则整笔加回。等级门槛由现有 LevelInfo 决定，不修改升级规则。过去测试中出现的 Grade8/GP9713 是旧移植直接扣经验造成的不一致，不能再解释为完整原规则；历史存档和失败记录保留，不回填经验。新方法在最终等级变化时重算血量、战斗力并发送一致的属性包，随后刷新等级任务；仅等级上升触发升级奖励钩子。客户端67包以GP推导等级，不单独传Grade。

该修复已有隔离测试证据，不等于原客户端完整自然战斗通过。测试角色仍通过正常邮件经验药水升级；副本等级限制、经验表和原退出提示保持。

结算页使用 `--asset=gameover` 汉化原fmt5位图29/30/31/32的“翻牌奖励、角色、功勋、经验”，其他149个tag原样。`workshop-bag-layout.mjs install --gameover-title` 在保留背包布局的基础上，仅把原gameOver.xml翻牌标题x250移到180，标题右边界986，原卡片位置和事件不变；相对已有部署仅该条目改变，其他100个压缩条目相同。旧账本迁移、失败恢复、外部漂移拒绝及六种旧模式一致性已验证，合计10项测试通过（Node24.14.1）；Node24.21.0测试进程曾出现原生cleanup_queue断言，保留环境失败。两项覆盖已部署且HTTP摘要回读，1x/4x深浅底离线预览已查看；尚无更新后的原结算整帧验收，胜负图片和其他战斗外文仍待处理。

```powershell
node scripts/workshop-bag-art.mjs verify --asset=gameover
node scripts/workshop-bag-art.mjs install --asset=gameover
node scripts/workshop-bag-layout.mjs verify --gameover-title
node scripts/workshop-bag-layout.mjs install --gameover-title
```

保留原等级规则。可通过已有管理员邮件给自己的本地角色发经验药水，正常领取后在背包使用。现有 `11904` 每瓶10000经验；从1级、GP1正常使用两瓶可升到9级，基础副本原门槛8级，训练场原门槛15级。邮件内物品是否已领取、升级是否保存必须分别核验，不直接写角色等级或经验。

普通竞技场选择“创建房间 → 开始”，本地 Match 队列约25秒后补入AI；“快速进入”只查找已有房间，单机空列表应创建房间。网站游玩页新增默认折叠的“单人怎么玩”，并保留英语、葡语说明。独立1级账号已通过实际领取/使用升到9级和重登保存，再完成两场正常AI匹配、移动、发射、伤害、结算、返回与重复匹配。这里是实际协议和存档验证，原客户端完整副本/竞技场操作仍需独立验收。

## 验证与备份

### 新武器的本地兼容包

时装导入不负责武器战斗配置。武器需同时具备数据库的 `Shop_Goods/BallConfig/Ball`、战斗引擎数据和原客户端资源；只新增数据库物品或调用 `reload-templates` 不会更新引擎已加载的武器。

`node --import tsx scripts/workshop-weapon.ts plan <package.json>` 离线检查一个完整类别7模板、四分支和1～4个完整Ball行；不补默认物理值。输入使用 `schemaVersion:1`、`mode:"local-compat"`、独立 `owner`、来源 `metadata` 及三表原字段。`verify` 绑定当前本机Workshop数据库只读核验；`install` 在同一事务只新增这些owned行。未知占用、部分安装或参数漂移拒绝覆盖；重复执行只有数据库、包和归属账本全部一致才无操作。账本 `prepared` 是写入意图，不能当作已提交收据，失败后须回读。安装器不发放物品、写资源、重启或宣称游戏验收。

需要引用已有本地弹体时，可显式使用 `schemaVersion:2` 并增加 `BallReferences`，填写1～4个完整 `game.Ball` 预期行快照；`Ball`只列本包新建行，可为空。两集合合计不超过4行，ID不得交叉/重复，每行必须被四分支使用。引用行在同事务内逐列比对，缺失或漂移拒绝；写后再次比对以检测触发器修改。它们不会被插入、更新或认领为本包所有物；已有武器引用这些球是允许的。只有 `Ball` 中的新建ID受原占用及悬空引用保护。全引用包预期只新增 `Shop_Goods:1 / BallConfig:1 / Ball:0`；plan/结果的 `ballIds`仍仅表示新建球，`referencedBallIds`另列只读依赖。prepared账本中的完整包保存依赖快照供核验，Ball所有权仍只来自 `package.Ball`。v1格式、包hash及原账本语义保持；没有新增卸载/删除命令。

v2仍须单独准备fight扩展和资源。现有fight loader已支持分支引用基础Ball及shape，引用已有球时无需在扩展的 `balls` 中重复定义；既有兼容武器须保留在合并扩展内。官方模板属性/装备PNG与所选本地弹道、倍率、延迟、弹体/爆炸、声音、尾迹及坑形应分开标注来源，不能把复用本地效果称为该武器官方原版效果。完整依赖和模板校验不代替原客户端装配、战斗与重登验收。

### 免费活动首批

在线宝箱的游戏数据改从原 `User_Box.Type=0` 加载，与 `LoadUserBox.xml` 同源，恢复 15/40/60/75 分钟和 1120090/1120091/1120092/1120093 四档。每次领取后重新计时，不是累计75分钟全部领取。等级/VIP礼包仍从 `LoadUserBox` 读取；旧表和原管理API保持。新增受管理员鉴权的只读 `online-box` 列表/详情与中文页签，写请求返回405，避免修改旧表却误以为改了在线奖励。原客户端固定时间及20级显示上限与服务端60级上限的差异仍保留；签到记录已与领取记录同事务保存。

在线领取现将领取记录、进度、背包奖励及溢出邮件放在同一事务中。事务失败保留原内存与领取计时；成功后先完整更新内存，再通知客户端，避免断线或后续存档撤销奖励。领取与自动保存、退出及入房使用既有角色持久化锁协调；正在房间内时暂不领取，回到大厅后计时与资格仍保留。包53回应恢复原 AS3 的 `boolean + int` 五字节正文，请求格式不变，等级礼包仍保持原独立路径。

世界BOSS结算源码现按开战时的服务端活动窗口和战斗ID计伤，拒绝过期、跨窗及同场重复结果；进入大厅而未造成伤害不产生奖励名次，同伤害按角色ID稳定排序。首次结束时冻结排名及当时奖表，结束失败保留该窗口重试，成功的领取记录阻止重复发奖。调度器串行执行转换，部分启动已建状态但通知失败时仍会到期收尾。

世界BOSS的领取记录、待保存角色/库存、奖励与溢出邮件同事务提交。在线仍立即入包/加币；离线仍直接增加金币/礼金，并补齐原先被忽略的实体物品邮件附件。默认奖励数值保持，当前仅接受这两种币及已有实体模板；不支持的奖励配置报错而不消耗领取机会。客户端包队列、角色保存锁、短暂战斗写入屏障协调提交与内存发布，排队的战斗操作恢复后沿用原绝对时间，不延长玩法计时；离线发奖与登录快照串行，温泉计时奖励等待同一保存锁。原95登录完成包在完整初始化和登录锁释放后发送，正文不变。

此前世界BOSS结算源码通过类型检查及10文件156项相关回归；其中27项发奖/调度/战斗边界用例和3项真实RSA登录交错用例又在两个独立原生PostgreSQL库通过。回滚断言两侧均完整克隆profile，保留全部字段与byte值，避免Buffer/Uint8Array载体差异。过程中发现并修复立即重登时序回归；一次Windows测试worker崩溃单独保留，未计为通过。这些证据不代表原客户端自然世界BOSS玩法已验收。

世界BOSS免费入口现共用服务端资格检查，建房、修改为type14、普通开战及快捷开战都需当前有效窗口、正确关卡、本人有效会话和武器，且角色不在其它战斗。排队及发奖屏障之后重新检查房主和成员；没有增加等级、门票要求。type14的94/2只接受已核实的三种完整客户端布局，按实际包长检查，不读取ByteBuffer的补零区；失败不改房间，其它模式保持原解析。

冷却由服务端记录同一窗口、角色和战斗ID：成功开战后按参考Create.GetTimeDelay战力分档计45/120/180/240/300/600秒，实际结束或退出另计15秒，均到期才可再次挑战。这是本地对两条参考计时规则的明确组合，不称官方完整规则；客户端状态字节不能清除或重复延长冷却，同ID重登保留，窗口结束清理，当前不跨进程持久化。同步开战失败不登记场次；多人退出按参与者处理，旧场回调不能改新场。未完成的付费复活及增益入口明确失败、不扣点券、不发成功包，OPEN不再列出未实现的可购增益；完整付费效果、跨进程恢复和原客户端自然战斗仍待验收。

12项原子性回归覆盖四类数据库失败、重复领取、脏合堆/支付保存、COMMIT期间自动保存与真实房间入口、通知失败；已分别在隔离PGlite及新建原生PostgreSQL测试库通过。在线协议15项和兑换/邮件/只读管理86项回归通过。原生测试首次有一项Buffer/Uint8Array断言表示差异，统一快照比较后12项通过；未修改生产bytea实现。完整190分钟原客户端领取、开箱动画和实际用户点击仍须另行验收，不能用这些测试替代。

`research/activities/local-festival.json` 定义独立活动100002「本地秋日庆典」，北京时间2026-10-12至10-18，每角色一次普通11904经验药水，通过原活动日历和事务邮件领取。`node --import tsx scripts/workshop-festival-activity.ts` 默认离线plan；`install`仅新增独立活动/奖励两行，`verify`回读完整内容与数据库绑定，未知占用或漂移拒绝。它不会延长活动、发放物品或清除领取记录。旧starter核验只对经过完整配置、绑定、账本和两行回读的这项活动做共存排除，原33/310行基线继续保持。原客户端现有响应补丁支持成功领取；后续已接入受当前游戏会话鉴权的个人日历记录，免费活动重登灰/亮按钮通过原客户端验证；服务端继续拒绝重复领取。

相关隔离测试：在线游戏15项、只读管理6项、节日/starter共存27项通过。源码测试与本机实际部署证据分别记录；不代表参考服全部活动已实现。材料兑换、世界BOSS、衣橱与寻宝仍需逐项验证规则及原客户端流程。

### 本地材料兑换

`research/activities/local-material-exchange.json` 定义活动100003：北京时间2026-10-13至10-19，每角色本期一次，用同一堆朱雀石1级（11001）中的2颗兑换玄武石1级（11005）1颗。输入可绑定或未绑定，奖励为永久绑定邮件。这是明确标注的本地配方，不是官方兑换比例；不更改物品属性或原等级要求。

`node --import tsx scripts/workshop-material-exchange.ts` 默认只生成离线plan；`verify`只读，`install`仅在当前本机Workshop数据库中新增活动、奖励、材料白名单各一行。同ID漂移、未知占用、部分行或账本不一致会拒绝；独立prepared账本先记录精确配置和数据库身份，三个配置行同事务写入。重复执行已安装且完全相同的配置不新增、不发奖。旧starter核验仅对拥有完整账本与三行一致证据的100003允许共存，继续核对其余原始基线。

原客户端按31号包发送活动ID、槽数及每槽的模板/位置/背包。服务器严格检查全部包体、精确模板白名单、同堆数量和本期领取记录；实际扣料、此前尚未保存的购买支付/拆合堆、领取记录及奖励邮件一起提交。失败保留原在线状态，成功后才通知背包与邮箱；满包可正常收奖励邮件。31号返回包另有旧用途，不能把它当成兑换回执。HTTP免费领取入口拒绝非普通活动，不能绕过扣材料。

`UserCalendar.ashx` 只向有效当前角色会话返回个人记录；普通免费活动读`Kind=active`，一次性材料兑换（ActiveType1/HasKey6/IsOnly1）读`Kind=exchange`，两类记录互不替代。共享`ActiveList`不包含个人状态。原日历覆盖在重登后合并已领状态。

本机隔离角色的真实HTTP/RSA/TCP/31/113/WS验证已通过错料拒绝、材料5→3、唯一永久绑定奖励邮件、重复零变化、收件及重登个人已兑状态；原生PG覆盖事务失败回滚和提交期间并发。原客户端也已实际通过原界面兑换一次，原背包和邮箱通知、数据库扣料与唯一未收奖励、重登灰态一致。先前主模块加载超时及材料槽裁切、成功提示遮挡、同会话按钮未即时灰的证据保留；本次修复与验收范围见下，不将观测差异解释成已证实的Chromium内部原因。

可选 `--exchange-state` 在已有中文、活动回调和个人状态补丁后，监听当前一次兑换页的邮箱通知并重读原 `UserCalendar`。117没有活动ID，只触发刷新；真实原模型确认已兑换后才灰化按钮并显示页内成功说明。在途通知合并为一次后续刷新，失败不清空已选材料，关闭页面拆除自身监听，换角色仍执行原身份检查。它不会重发兑换或新增领取操作；原日历请求仍包含既有月历规范化行为。

该功能须同时启用布局 `--calendar-exchange-layout` 及当前中文词典：`node scripts/workshop-literals.mjs install --exchange-state`、`node scripts/workshop-bag-layout.mjs install --calendar-exchange-layout`、`node scripts/workshop-language.mjs install`，由正常停止/启动流程统一部署。对应 `verify` 可预览与回读；以后省略选项仍保留账本记录。布局仅将单槽兑换材料区移出详情滚动区，显式维护原VBox子项列表；多槽及其它活动恢复原父容器和尺寸。原XML样式不改，只新增五个点。回退遵守各覆盖owner账本，不能混用升级前后的文件。

此项已正常部署；50项联合回归及实图边界修正后的19项相关回归通过。单槽说明按材料列表实际可见边界定位。一次原客户端兑换及新登录均已通过：实际材料5→3、唯一永久绑定未收奖励邮件、鉴权API与原模型true、同页立即灰化及重登保持，五张初始／背包／填料／成功／重登画面已实际查看，数量和说明完整且不压底部操作条。独立原生PG前后回读核对其他库存、非登录属性和邮件保持；测试前排行榜正常重算的两项派生值单独核实并记录，没有回写数据。此前加载超时的pending保留，确认未兑换后才作一次独立恢复。成功采集不读取浏览器主模块响应体，只分别核对服务器资源SHA及真实浏览器URL、长度、完成事件和原客户端行为，不能称浏览器主模块字节身份通过。多槽原页面、剩余外文和全界面视觉仍待验收。

安装配置后需要重载活动模板，新增Flash覆盖路径需要正常重启API来刷新启动时资源索引。游戏端源码变更也必须重启生效；须在角色离线、无房间且完成备份后由Workshop正常启停。隔离事务测试不代替现役配置、原客户端兑换/邮件领取及重登检查。

### 日历内嵌中文标签

`node scripts/workshop-calendar-art.mjs candidate [新的私有输出目录]` 仅生成中文位图候选；覆盖星期、时间/奖励/内容、返回、每日领取与活动标题等，不改ActionScript、命中层或动态字段。`calendar-controls.zh-CN.json` 基于已有“隐藏”中文覆盖，只修改共享`coreii.swf`的领取按钮；必须保留其父账本与原件，不能用新SHA冒充旧“隐藏”安装器仍拥有整个文件。生成报告的静态像素一致性不代表原客户端显示通过，需在真实月历和已领/未领详情检查。

游戏服务可显式配置 `FIGHT_WEAPON_EXTENSION=<绝对路径/fight.json>`，启动时追加武器；默认关闭。该JSON使用 `schemaVersion:1`、`source:"local-compat"`、`items/ballConfigs/balls`，字段与 `@ddt/fight/node` 的 `LocalWeaponExtension` 对应。新武器必须有完整配置，既有item/config/ball不得覆盖，新增弹体必须被使用。挖坑弹体可显式引用现有本地shape，或在 `shapes` 中提供 `{ballId,source:"official-image-derived-local-mask",fileBase64}` 的原Tile二进制格式；后者严格检查base64、尺寸和长度，仍是本地派生形状。全部检查通过后才合并，新包失败不会静默退回旧武器。

配置仅在启动加载，首次接入前须核对数据库XML、fight包及资源一致并确认无在线角色/房间。官方基础属性、原版视觉文件、本地弹道/延迟/形状各自记录来源；本地运行通过不代表官方战斗完全复刻。当前武器通道与隔离测试已实现，实际新增武器的原客户端效果、正常操作、保存和发放仍需独立验证，不据通道完成把新武器数量加一。

`workshop-smoke.ts` 走实际 REST→Flash RSA→TCP/WS 登录、大厅、双账号组房聊天及重连；`workshop-battle.ts` 走真实25秒机器人匹配、移动、开火、伤害、结算、翻牌、回大厅及存档重登。使用便携 Node24、`TZ=UTC`，不启用测试引擎或放宽票据。

`node --import tsx apps/api/scripts/workshop-shop-smoke.ts --run` 用新的本地测试角色，通过正常HTTP/RSA/WS登录购买原商城1310201商品。实服XML核对后，分别检查44响应、38精确扣159点券、64新增一件绑定7天海盗套装，以及正常退出后的稳定ItemID和新连接读回。44响应本身不足以证明购买成功。已实际完成一次购买、保存与精确回退；这项协议业务验证的 `renderingAccepted` 始终为false，不能代替原客户端商城操作验收。

该脚本仅访问回环API，账号与完整账本留在私有runtime。必要时补足测试余额，并在补款前落盘原余额、外观及库存基线；正常离线后仅将本次自有购买行置为IsExist=false/Count=0、还原余额，再以新连接确认不再加载。测试账号、任务副作用及失效物品行保留。`--rollback` 只恢复已记录的一批，不再次购买；缺少基线时明确失败并保留账本，不猜测原余额。存在未完成账本时拒绝开始新批次，尚未创建角色或购买的preflight失败可以安全重跑。证据为 `runtime/content-research/shop-lifecycle.json`。

`workshop-card-fixture.mjs` 将已核验备份恢复至随机独立数据库，独立启动实际API/游戏，固定副本地图与免费金币掉落，通过两场真实对局验证+15000金币。它不会改正常存档的地图/掉落，不代表随机正式服分支的概率覆盖。

`workshop-render.mjs` 用独立 headless Chrome/Ruffle 与原 public AS3 内部测试入口，读取网络/日志并保存原始截图，不模拟鼠标键盘。仅允许回环栈；测试票据不会被临时页面暴露到 LAN。截图生成不自动等于玩法验收。

`research/client/WorkshopWardrobeProbe.as` 编译后供 `--probe=wardrobe --fixture=wardrobe` 使用。编译SWF留在私有 `runtime/content-research/WorkshopWardrobeProbe.swf`（或 `--probe-file` 指定的私有runtime路径）。启动前必须有真实 `--apply --hold` 账本；角色、道具、模板与Pic由当次账本注入并精确核对，不复用旧测试编号。只有确认原公开卸下/穿回响应与角色完成显示才报告 `wardrobeRestored:true`；默认90秒上限，错误或超时明确失败，随后用正常 `--rollback` 核验回退。日志中的账号、密码与Flash key及URL编码形式统一遮蔽。参数化版本已用新的随机Pic、道具与账号实际穿卸并回退。

`workshop-peer-render.mjs` 运行两套原版SWF；AS3入口为 `research/client/WorkshopPeerProbe.as`，编译产物留在 `runtime/client-research/WorkshopPeerProbe.swf`。脚本使用 `node --import tsx`，`--validate` 只核对真实地图/协议导入。正常测试先等A的原RoomListView完成，再启动B；原版自由挑战要求发起者至少12级、目标至少4级，等级不足明确不通过。`--assist-room-loading` 只供隔离诊断，结果始终区分自然与辅助路径。已在纯测试角色临时合法等级下实际完成自然双客户端对局并还原等级；未修改默认Ruffle15秒执行限制。该Freedom对局验证金币保存，GP/Total/Win没有增量，不能据此宣称这些奖励通过。

`workshop-solo-render.mjs` 与 `research/client/WorkshopSoloProbe.as` 单独核验普通竞技场：默认 `--validate` 离线检查身份及命令边界，`--compile-only` 只编译；`--run` 登录建房并观测自然加载，显式 `--battle` 才继续原公开射击与结算链。探针只接受现有私有经验药水账本的专用角色ID11，明确拒绝用户角色ID6，不自动建角色、升级或领取邮件。对局会正常改变专用角色的经验和存档，不重置或修复结果。使用当前回环栈和独立Chrome profile；临时UUID页面沿用既有web Origin，创建后立即记录文件所有权，正常退出或捕获异常时删除本次临时票据/两级SWF。账号、密码、Flash key、token及URL编码值在日志中脱敏。强制终止进程可能跳过finally，需按精确UUID及最新进程证据清理，不能扩大删除范围。

```powershell
node scripts/workshop-solo-render.mjs --validate
node scripts/workshop-solo-render.mjs --compile-only
# 当前服务空闲、专用角色离线时才运行；Java使用现有WORKSHOP_JAVA或JAVA_HOME
node scripts/workshop-solo-render.mjs --run --seconds=240
# 实验性原公开射击、自然结算链，最多720秒
node scripts/workshop-solo-render.mjs --battle --seconds=720
```

自然加载路径调用四个原公开方法：进入roomlist、创建type0/time3房间、设置原随机地图0、开始。它等待原房主状态与设置确认；`--run` 开始后只观测，不发射或跳过回合。两种模式都不发送加载进度、不强切战斗状态、不模拟鼠标键盘。START_LOAD先于原加载所有者初始化，因此此时仅记录事件，武器/弹种等深资源检查等待原PROGRESS_CHANGE自然达到100。加载视图的ADDED事件与真实显示树证据分别保存，必需type1/2资源严格要求完成，未观测值不作为通过。

`--battle` 在原Self回合、实际当前玩家、射击资格、移动和动作队列连续稳定时，每回合至多一次调用原 `manuallySetGunAngle → beginShoot → sendShootAction`。上限16次公开射击请求，保留原多发规则；不直接发送射击数据包、不改方向/坐标/血量、不跳过回合。瞄准仅用原纯EulerVector和当前完整Ground/stone私有克隆，复用原生矩形交集与四角alpha判断，射击前比较完整地形和当前资格，过期即丢弃。每回调最多两条轨迹，每条最多400步/5000次扫掠；原Number与服务器float32不保证数值等价，完整克隆与比较耗时仍需实测。

显式 `--battle --diagnose-facing` 可在原回合已报告合法角度背对目标、随后同回合零射击观测保持时停止诊断；默认两种运行模式保留原等待行为。该观测的shootingGate来自上一约250ms tick，且没有新方向/坐标读回，不能推断整场持续不可射击。诊断退出不计自然结算、胜利或完整玩法。CDP错误保留方法与截图/关闭阶段，参数和URL不入证据；收尾异常另行保存，不覆盖主要诊断。

纯预测另记录 `solo-aim-stage`：ground/stone克隆、完整比较及首条Euler预测的前后边界，每个私有job最多十条，默认观察模式不进入这些阶段。收集器仅保留固定阶段和计数的 `lastAimStage` 摘要；null地形可能直接返回，最近边界不能证明具体崩溃指令或后续工作未执行。离线字段/隐私边界检查、Flex编译及独立审查通过；两次真实原竞技场在地图1071/1061自然开局后，均于预测前触发同回合零射击的朝向诊断，约55秒退出，无浏览器或CDP错误。两次正常WS重登保存检查通过，专用角色各按原业务扣108经验，其余等级/外观/币种/物品保持；没有回写。新clone/compare/Euler阶段尚未实际覆盖，不能称Ruffle崩溃已定位或完整对局通过。

真实自身弹体、目标血量减少和自身命中分别记录；预测命中不算伤害通过。仅在实际命中、自然GAME_OVER、原经验/翻牌或合法无牌分支、返回大厅全部完成时才接受完整对局。截帧前后复核原state/view/nextState，变化则记skipped；画面与重登保存还需独立核对。首次固定角度100次请求已自然结算但无伤害；第二次有限角度16次请求仍无伤害，且有Ruffle WASM越界错误，保留失败与正常扣经验。纯物理候选已通过离线边界检查、AS3编译和独立审查，两处碰撞/截图P2已修正。第三场自然开局于地图1201，但角色背对目标，0次射击、0伤害；720秒截止报未定位具体方法的“Internal error”，未观察原GAME_OVER及结算页。正常WS重登证明存档一致，本轮专用角色实际GP+1/Win+1/Total+1，这些计数不能替代原客户端胜利证据。第四场自然开局地图1007，但首次瞄准阶段Ruffle变换栈断言，240秒内0发射/0伤害，无结算；完整地形clone/compare的具体执行阶段未记录，不能认定已运行或完成。正常WS重登保存一致，原业务GP−108，其他等级、外观、币种和物品不变。各次失败保持独立证据，不回写历史存档；命中、更新后结算页和完整玩法仍待验收。

2026-10-11一次当前源码的实际运行exit0：原大厅/普通房间→约25秒AI匹配→原RoomLoadingView显示树→真实100%本地进度→GAME_START及fighting完成；地图1023、专用角色和负ID机器人双方人物/movie/弹种资源均完成。主控查看原战斗整帧，人物、地图、双头像、小地图及控制区可见。早期加载截图仍为过渡黑帧，只接受其显示树/自然进度证据，未验收稳定加载页画面。四次此前中断/探针失败分别保留，不能合并为成功。关闭测试客户端可能触发现有对局失败/扣经验，属于专用角色正常业务副作用，不回写用户角色。五个既有覆盖资产及真实用户角色基线再次核对保持。完整原客户端开火、伤害、结算、普通副本和点击操作仍未完成。

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

### 战斗道具自动返包的保存语义

道具从不持久化的 `FightBag` 自动返包时，并入已有堆栈使用 `removeItem(item, 26)` 保存源物品的删除；进入空槽继续使用 `takeOutItem` 移交同一物品。即使原来源背包已中途保存，正 ID 源记录仍会失效；数据库写入失败保留待删除队列供重试，临时 ID0 不新增数据库记录。此修复不改堆栈上限、道具效果或历史异常行。

新增五项真实 PGlite 回归覆盖中间保存后并栈、源 UPDATE 失败重试且目标不重复累加、普通及满堆栈对照的空槽返还、ID0并栈。原客户端两瓶正常怒气道具的消费与原生存档已验证；自动返包补丁通过7组63项隔离UTC单worker回归及game类型检查，尚待正常部署后的客户端返包验收。完整自然对局仍未通过，不能据数据库回归推断移动、命中和结算已完成。

### 原活动图标与提示/任务图片文字

`scripts/native-menu/build-original-art.mjs` 从已保存的原大厅资源提取17个活动图标及背景，保留18份原位图tag与透明度。纯资源导出使用独立的 `workshop.menu.art.*` 类名，不导入原大厅业务代码；桥在子 `ApplicationDomain` 加载。图标使用原尺寸和图片自带中文，背景按原 `34,30,34,30` 的左/上/右/下九宫格扩展。首次加载可关闭，迟到回调不得重开旧窗口；激活仍在“更多”。

联合构建增加精确资源 `/flash/workshop-native/menu/hall-activity-original-art.swf`，以 `nativeMenuArtVersion:1` 区分90资源版与旧89资源版。安装器保留旧菜单ABI及全部旧资源，校验真实编译桥中的加载入口与精确资源集合，不允许省略原图包降级；沿原日志完整回退。`scripts/native-menu/build-menu-upgrade.mjs` 需要显式旧清单及SHA，只重编共享桥和图标资源，复核其余编译输入并逐字节保留89个活动文件。

`scripts/workshop-tooltip-quest-art.mjs candidate <新目录>` 构建3份提示/任务SWF，`verify [候选目录]` 只读校验，`install <候选目录>` 按独立 `client-overlay-tooltip-quest-art.json` 安装，`rollback` 精确恢复并保留备份。只修改已核45个位图，保持尺寸、原边框、数值起点及521个未选tag；不接受未知源、已被其他覆盖日志接管的目标或外部修改后的回退。当前覆盖品质/类型/伤害/角度/绑定、任务分类双状态及领奖等文字；物品/任务正文另由上述模板显示覆盖提供。其他奖励类型图片和未覆盖数据仍待后续处理。

本批实际安装与无参校验、隔离升级/回退及原件像素比对通过；静态组装预览与源码双体测试不代表AVM2实机验收。重新启动Workshop并关闭旧游戏页后才会载入新桥及模板文本。

后续原图版使用 `scripts/workshop-tooltip-quest-art.mjs candidate-original <新目录>`，按 `research/i18n/tooltip-quest-art/original-resources.json` 移植三份包的332处原位图引用；313个位图tag实际变化、250个其他tag保持，仅92个纯BitmapData构造器默认宽高适配，所有方法体保持。支持从上一版45处绘字覆盖升级，保留旧输出和原始备份；失败补偿恢复旧输出，禁止直接降级。回退不依赖原素材缓存可读，工具/配置/目标/备份仍须匹配。原包不随源码发布，精确输入缺失时不得构建。

配套 `scripts/workshop-bag-layout.mjs install --original-tooltip-layout` 只增改coreI.xml三个提示坐标，沿现有日志保留四项已安装布局。当前三份原图及坐标已安装，完整332映射、升级/失败恢复/回退和无参校验通过；原任务分类、奖励标签、领奖按钮及品质/类型/伤害/角度/绑定等采用原中文图片，动态物品和任务正文仍由模板显示覆盖处理。未移植参考服业务代码或装备属性，AVM2、全界面中文和17活动完整验收仍未完成；详见上述目录README。

### 原始武器音效与视觉升级

`scripts/workshop-weapon-audio-assets.mjs` 仅从固定原包取出奶油熊的 Sound252–257，保留六段原压缩音频，只重分配 CharacterID；扩展本地唯一 SymbolClass，保留132个旧音效、旧ABC及其他旧tag。重编的六个Sound包装类只有父构造调用，不引入参考服业务代码。构建输出须先按哈希核验并放到私有 `client-overlay/audio.swf`，再用 `workshop-literals.mjs install --weapon-audio` 将六项注册合入现有核心覆盖。省略参数保留该补丁；`verify/install` 拒绝缺失或损坏的音频，完整核心回退不依赖音频文件仍在，且不覆盖被外部改动的音频。此音频文件是额外覆盖，回退核心后不自动删除。

泡泡茶的六份原始SWF仅提供原动画资源，尚无权威官方BallConfig。`workshop-weapon-visuals.ts` 只将已归本地所有的9107258从四个只读共享Ball引用升级为四个独占视觉Ball；只改变ID、Name、BombPartical及本武器的四分支绑定，Shop_Goods整行、物理、声音、粒子和原坑形保持。原ownership journal不改；独立prepared升级日志在事务写入前持久化，完整旧态可重试，匹配日志的完整新态无写返回，漂移/占用/共享/部分状态拒绝。官方装备强0属性保留，不将本地兼容弹道称为官方规则。

可选私有配置 `WORKSHOP_WEAPON_VISUAL_UPGRADE` 指向固定部署清单；全局 `FIGHT_WEAPON_EXTENSION` 仍保留旧包。启动器在自身DB ready和恢复证明检查后、API/game之前运行一次升级：逐SHA核对old/new包、原日志、两版FIGHT及实际上传目录的六个SWF，再核本次runId、正PID、真实数据库/目录/端口/UTC。成功或已新态均在本次进程环境中显式选择新FIGHT，避免上次DB已提交而缓存未激活的情况。子进程必须返回成功消息且退出0才继续开放大厅，失败自动停止本次自有进程；LAN监听保持。此部署清单只拥有原ddtank库，恢复副本不满足绑定时在连接/写入及API/game之前拒绝，需另行提供一致性验证，不能静默猜选FIGHT。

原素材与私有配置不随源码发布。当前音频覆盖已安装；泡泡茶资源及启动升级清单已准备，生产数据库尚未激活。奶油熊14301/14302原粒子定义仍缺，保留兼容尾迹，不能宣称原特效全部齐全。隔离音频/动画组件结果、数据库回归与完整游戏验收分别记录，组件通过不代替实战验证。
