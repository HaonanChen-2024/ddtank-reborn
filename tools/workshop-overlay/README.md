# 客户端 overlay 离线重建

本目录迁入 `source/ddtank-reborn/tools/workshop-overlay/`。默认按该正式位置寻找项目根，也可用 `--root=<DDTank-Workshop绝对路径>` 指定。工具仅读取输入并写入指定的新输出目录，不安装、不修改现用 overlay，也不启动、停止、重载服务，不访问数据库或游戏浏览器。

## 四种行为分开记录

- **严格重建**：从 repo 原件和已纳入的允许来源构建。清单覆盖 119 个目标，目前 7 个有实际逐字节成功证据，另外 112 个逐文件列为例外。不会复制历史候选 SWF 冒充生成。
- **附加历史素材重建**：room、roomlist、email 从 repo 原版基底、原始供体/PNG/格式化源文字及纯构建代码生成。3 个结果均与现役 SHA256 相同，但需要额外历史素材包，因此不计入严格模式的 7 个。
- **完整原件复制复现**：8 张本地 vendor 原版服装 PNG、23 个有 URL/hash 下载回执的参考完整资源，直接从固定原件包复制。结果为 `source-copy-exact`、`generation:false`，不计入脚本生成，也不使用历史 overlay 候选恢复副本。
- **归档恢复**：显式 `restore-archive` 逐文件校验已生成成品后复制，结果为 `generation:false`。它是恢复能力，不增加重建覆盖率。此模式本轮未执行。

正常安装位置下，从 repo 根执行一条命令（`node` 需指向已安装的 Node 24；不自动安装依赖）：

```powershell
node tools/workshop-overlay/rebuild.mjs all --out="C:/path/DDTank-Workshop/runtime/overlay-builds/all-001"
```

`all` 顺序运行严格生成、附加历史素材生成和原件复制，将当前运行中成功复现的文件汇集到 `rebuilt/`，并对 119 个目标写统一 `report.json`。隔离验证结果为 10 项精确生成、31 项原件复制、78 项逐文件例外；生成项中 7 项为严格来源，3 项明确额外依赖历史原素材。实际失败如实记录并返回非零码，不沿用预期成功数字。`strict/report.json`、`extended/report.json` 和 `source-originals/report.json` 保留各自证据。按需审计仍可单独运行：

```powershell
node tools/workshop-overlay/rebuild.mjs rebuild --out="C:/path/DDTank-Workshop/runtime/overlay-builds/strict-001"
node tools/workshop-overlay/extended-build.mjs --out="C:/path/DDTank-Workshop/runtime/overlay-builds/extended-001"
```

每次 `--out` 必须是项目 `runtime` 内尚不存在的目录。拒绝 `client-overlay`、`uploads`、`live`、官方输入目录及其子目录，拒绝经符号链接逃逸后的路径。构建产物不得写入 repo/tools。现用 overlay 存在时仅做前后只读快照校验；不存在时按清单中的目标 SHA256 正常构建，不要求先恢复成品。

计划查看与明确恢复示例：

```powershell
node tools/workshop-overlay/rebuild.mjs plan
node tools/workshop-overlay/rebuild.mjs restore-archive --archive="C:/path/DDTank-Workshop/runtime/live/explicit-overlay-snapshot" --out="C:/path/DDTank-Workshop/runtime/overlay-builds/restored-001"
```

## 固定输入和工具链

`runtime/live/overlay-inputs/sources.json` 记录 108 个额外原素材，共 7,373,738 字节：79 张参考供体导出 PNG、22 张已审核图像生成 PNG、1 个参考原 SWF、6 份格式化源文字。每个文件以 `sourceId`、SHA256、原来源路径和证据关联保存；recipe 只使用固定素材路径。没有历史候选 SWF 或已编译 tag 补丁输入。

同包保存 40 个 FFDec 工具链文件，共 22,238,954 字节，包括现有 jar 依赖和许可。素材和工具均为额外本地大包，不纳入本次 Git 文件组。来源原件保留。该包不属于严格模式允许来源根；不得把它称为从 repo + vendor + official-capture 独立重建。

`runtime/live/overlay-originals/sources-verified.json` 另固定31个完整原件，共5,180,371字节。8张服装图来源是现有 `source/gunny30-resource` 原版目录（没有可证明的原始下载URL，明确记为本地vendor原件）；23个参考资源都用现有下载记录核对URL、原始落盘SHA和当前目标SHA。ddplay记录有下载时间、匿名标记、字节数和SHA但未记录HTTP状态码，不补造状态。原件不是候选成品；随包 `original-sources.json` 保存逐项证据。复制结果仍需每文件目标SHA相等。

本次实际使用 `pngjs 7.0.0`、`@napi-rs/canvas 0.1.100`（Windows x64 native同版）、`jszip 3.10.1`，默认读取 Codex 的现有依赖目录，可通过 `--deps=<含package.json目录>` 或 `WORKSHOP_NODE_DEPS` 指定。Node为24.21.0，Java为OpenJDK22.0.1+8-16。`toolchain.json` 和主manifest记录各包版本、入口/元数据SHA，以及 `msyhbd.ttc`/`msyh.ttc` 的完整SHA与大小。字体使用现有 Windows 微软雅黑；扩展模式还调用 PATH 中的 Java。没有下载或依赖安装步骤。字体/渲染器/编译器差异如导致目标字节不同，会保留输出或错误证据并停止该文件，不更新目标 pin。

FFDec 使用 CLI、独立 `user.home` 和 `windowsHide:true`。不能添加 `-Djava.awt.headless=true`：实测会改变嵌入字体字形，导致已审核目标 font tag 不同。PNG Buffer 解码器对少数图像元数据误判时，只进行同 RGBA 像素的无损重编码；最后仍校验所有目标 tag 与整包字节。

## 原版基底与临时例外

统一规则为 **repo 保留原版基底，overlay 由脚本生成，无法生成的逐文件列例外**。room、roomlist、store、ddtstore、storefinebringup 的 repo 原件已由主控恢复；本目录不写这些文件。

`wonderfulactivity.swf` 是目前唯一临时兼容例外：当前运行服务的旧 CiTree 索引仍指向 repo 文件，直接恢复原版会使 HTTP 退回原版。因此主控保留中文 mirror，待用户批准重启、重新索引并验证 HTTP 后再恢复。此 mirror 不可作为“原版生成输入”或重建成功证明；原字节仍可从仓库既有 LFS 对象读取。本工具不恢复此文件也不触发重启。

之前“repo 同路径 28 项、其中 22 项不同”是恢复前盘点快照，不能当作当前比对结果。

## 小源码集合与验证边界

新增源码仅含 4 个纯变换模块（bag renderer、SWF bitmap builder、static text builder、font layout）、2 个 CLI、1 个 `all` 汇总器、1 个已证原件复制模块和 1 个路径/只读快照辅助模块，以及清单与 recipe。继续复用 repo 中已有的 bag/calendar/layout/lib 纯 API，不迁移整个 422 脚本集合，不执行历史日期目录内的 builder。随包 `entry-audit.json`/`.md` 逐项解释原 91 个 import 闭包文件和另 10 个早期来源入口的角色与未迁原因；它们不是正常构建时的依赖。

代码 pin 仅归一化 CRLF 为 LF，字词变化仍失败。资产、格式化文本、输入/输出 SWF 和图像严格使用原始字节 SHA256。新 JSON/文本用 `.gitattributes -text` 保真，代码固定 LF。原有 repo byte-pinned 配置也应保持仓库属性与已记录字节一致，不能为消除 pin 错误重写资产或目标 hash。

`pin-sources.json` 比对两种成功构建实际读取的全部 61 个 repo 输入与 HEAD blob（LFS 文件按指针 OID/size 对照原件），并包含固定原素材包的逐文件来源。当前代码换行差异由LF pin处理；`apps/api/assets/flash/ui/vietnam/language.txt` 与 `research/i18n/zh-CN-overrides.json` 需要根 `.gitattributes` 精确 `-text`，把现有工作字节存档，不修改词典。room/roomlist原版回置尚未进入旧HEAD的差异应随主控原版基底提交处理，不能改目标pin。私有主机路径均使用项目相对路径或 `<PROJECT>` 占位符。

修后证据：严格 `staging/run-2/report.json` 7 项相同；`staging/extended-4/report.json` room、roomlist、email 3 项相同。两类实际运行前后现用 119 文件和所有读取源均未改变。

`staging/portability-validation.json` 另有完整隔离验证：只复制22个原始输入/代码文件，在正式 `source/ddtank-reborn/tools/workshop-overlay/` 布局运行，不传 `--root`，整个fixture不存在 `client-overlay`，仍生成7项精确结果；4个owner代码改为LF后pin检查通过。5类输出边界拒绝也通过。此fixture不读取或写入现用overlay。实际repo正式路径验证仍由主控执行。意外生成差异或构建错误会返回非零退出码，已明示的逐文件例外不会伪装成构建错误或成功。

`staging/all-portability-validation.json` 证明最终一条 `all` 命令：从243个必要文件（repo源/原素材/工具链/来源清单）构造全新的正式项目布局，没有 `client-overlay`，不传 `--root`，完成41项逐字节复现（10生成+31原件复制），78例外，0错误。未读取历史生成候选或现用成品。该fixture内的 `runtime/all-build/report.json` 保留119目标明细。

字节相同证明离线生成复现已冻结文件，不代表本轮游戏界面或运行闭环验收。
