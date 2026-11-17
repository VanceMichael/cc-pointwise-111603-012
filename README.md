# 包裹轨迹汇集器

Node.js 本地数据接入项目。已有一次来源读取、结构化导入与操作查询，来源服务和业务存储独立，来源变化不会自动刷新本地集合。当前导入以 sourceId 保存最新观察；历史版本、完整批次、身份决策及恢复流程尚未纳入旧集合的接入生命周期。`src/tracking/` 提供另一套只追加事件日志与客服投影：日志不可变、可整体重放，投影不把“最后收到的一条”当成包裹状态。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为与本地接口测试；`npm run demo` 启动临时来源、读取首批并展示业务查询，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json`（轨迹场景见 `fixtures/tracking-source.json`）并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析现有首批页面并保留原始来源属性，返回 records 和 next；目前 demo 只导入首批。`src/service.js` 与 `src/repository.js` 维护持久集合；`src/operations.js` 是读取该集合的业务消费入口，来源协议见 [CONTRACT.md](CONTRACT.md)。

### 可重放事件日志与客服投影（src/tracking/）

- `journal.js`：只追加日志，持久化到 `var/tracking-events.json`（可用 `--journal` 覆盖）。每条 entry 保存 `raw` 原始事件、来源时间 eventTime、接收时间 receivedAt、本地记录时间 recordedAt、batchId 与日志序号 sequenceInLog；重复接收新增 entry，撤回不删除原事件。
- `projection.js`：纯函数投影与检查点。按 carrier/parcelId 分组，依据来源序号（而非接收顺序）重建时间线；序号缺口、缺少揽收、非法跳跃、签收后再扫描、来源时间矛盾、悬空/成环撤回、内容冲突的重复事件都会给出带 evidence 的待核对原因（`assurance=pending-review`），不补造运输过程。重复接收（duplicate-receipt）、补传（late-arrival）、撤回签收（delivery-retracted）作为 info 原因保留可追踪记录。
- `service.js`：`record(events)` 追加一批并返回当前投影；`replay()` 从日志重建投影与批次检查点；检查点记录每批 opened/resolved 的原因，迟到事件补齐后恢复 confirmed，同时保留之前不能确定的依据。
- `operations.js`：客服读取入口 `readTrackingOperations`，返回状态可信度、原因、时间线（含 retracted 状态与 retractedBy）、撤回引用、重复与补传记录。

CLI 新增 `track-ingest [文件]`、`track-query [包裹号]`、`track-log`、`track-replay`，均支持 `--journal 路径`；旧 `ingest`/`query` 行为不变。

状态目录属于运行产物。扩展导入时应保留现有 CLI 和现有集合查询能力；新增状态可以另行组织。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。运行录制可用 test 和 demo，无需安装浏览器或外部数据库。

`npm start` 或 `npm start -- --help` 查看命令；原导入和查询使用显式的 ingest、query 动作。`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放与业务查询，并覆盖轨迹日志的待核对、补传恢复与撤回回退，完成后清理临时状态。
