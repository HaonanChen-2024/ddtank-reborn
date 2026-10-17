# 第四步：测试恢复记录

相同输入连续两次apps/game全量正常退出：每轮1194通过、20跳过、0失败（76文件：74通过、2专用PostgreSQL文件按原opt-in跳过）。两轮分别耗时312.195秒和482.137秒，exit0。命令为原全量vitest run，保留原超时与主机时区；追加只读生命周期记录、JSON和hanging-process reporter用于核实退出，没有增加超时、删除断言或强制退出。输入SHA一致，详见同名JSON；完整日志在项目runtime/engineering-rebuild-20261017/tests/step4-full-02.*与03.*。

## 修复范围

- 19项旧文本断言逐条对照已批准中文化的owner；只更新字词/标题，保留金额、奖励、重复拒绝、事务、邮件、库存和协议断言。逐条依据见[旧文案审计](test-expectation-audit-20261017.md)。
- 2项师徒超时：PGlite timestamp-without-time-zone的defaultNow按宿主时区生成，Drizzle按UTC解码，测试初始角色被误判处于未来冻结期。Asia/Shanghai复现、UTC通过；测试fixture显式设置历史freezesDate，生产规则和存档不改。登录95已收到，丢失的是后续师徒回复。
- 独立生命周期探针证实公会60秒扫描定时器在GameServer.stop后仍留存。停止时只清理已创建的manager，等现有load完成，不为停服新建manager，也不关闭注入数据库；新增3项真实登录/停止回归。
- 8文件窄回归111/111通过；typecheck 9包通过，命令`pnpm -r --filter "!launcher" typecheck`；fight 338/338通过。新增`pnpm typecheck:workshop`统一入口。HANDLERS已按实际registry说明54/55、92/183与待重启边界。

## 不扩大结论

历史上18项登录95成片超时本轮没有复现；4文件进程观察确认每文件独立fork，前一worker已退出，因此不能把时区问题或公会定时器宣称为已证明的跨文件污染根因。第一次全量虽断言全绿，但测试主进程退出阶段异常；为了采栈动态开启Node调试触发原生断言，实际exit134，该轮不计验收。后两轮从启动时观察，正常退出；此前退出异常根因仍未确定，失败日志保留，没有靠强制退出算成功。

20项原生PostgreSQL用例需要专用隔离环境，本轮未启用；只用离线PGlite，不连接现役数据库或玩家。测试通过不等于原窗对战/全页面中文验收。
