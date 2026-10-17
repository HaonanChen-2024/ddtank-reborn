# 本地固定启动输入

此目录固定同一套本地数据、玩法和资源选择；不存放凭据。`.env.workshop` 继续为本机私有配置。配置路径由 `scripts/workshop.mjs` 从仓库根解析，与调用者当前目录无关。

当前选择：

```dotenv
FIGHT_WEAPON_EXTENSION=config/workshop/weapons/fight-baseline.json
WORKSHOP_WEAPON_VISUAL_UPGRADE=config/workshop/weapons/startup-deployment.json
WORKSHOP_LIVE_PROFILE=config/workshop/live-profile.json
```

`FIGHT_WEAPON_EXTENSION` 是既有升级链的基线输入。正常启动完成既有所有权校验后，游戏子进程才选择 `fight-effective.json`，不能直接把 `.env` 改成最终包绕过基线契约。

`startup-deployment.json` 和 `effects-deployment.json` 的 schemaVersion 2 明确使用 `pathBase: "repo"`，只允许仓库或同项目 `runtime` 内的相对路径。schemaVersion 1 的既有绝对路径清单继续支持，资源 SHA256、数据库绑定和所有权日志内容校验保持原契约。

启动前只读验证 `live-profile.json`、它固定的 `live-inputs.json` 和其中 33 个必需文件；当前共读取 35 文件、9,006,718 字节。覆盖战斗定义、中文定义/词典、原有武器图音效依赖及官方证据，不遍历 vendor 全树。校验发生在取得 Workshop 会话和启动数据库之前。正常运行中不自动热重载或更新 hash。

离线校验（不会启动服务或连接数据库）：

```sh
node scripts/workshop-live.mjs
```

文件缺失、hash 变化或 `.env` 选择与 profile 不符会停止校验。计划中的资源/翻译更新需要一起审阅并更新 `live-inputs.json` 中的对应 pin，以及 profile 对 inputs 文件的 pin；不要用自动刷新掩盖未知输入变化。`config/workshop/** -text` 保证 Git 检出保留这些定义的原字节。

日期目录内的 13 个运行输入已复制到本目录及 `runtime/live`；原件全部保留。旧启动收据保留，新收据由未来正常启动写入 `runtime/live/state/weapons/startup-activation.json`，不作为固定输入。两个稳定的原始/visual 所有权日志继续使用 `runtime/weapons` 原路径；effects 日志新副本保留旧字节和原 visualJournal 路径，不弱化身份校验。

`runtime/client-overlay`、`runtime/uploads`、`runtime/server-language.txt`、vendor 和 Ruffle 保持现有位置。原包 metadata、官方证据中的历史来源引用以及现有数据库所有权绑定保留原件内容；相对路径支持不代表可把该本机数据库所有权记录无校验地移到另一台机器。

迁移来源和前后 hash 见项目 `runtime/engineering-rebuild-20261017/config/live-migration-receipt.json`；离线严格解析证据见同目录 `live-read-proof.json`。实际启动与游戏验收须另按当前授权执行。
