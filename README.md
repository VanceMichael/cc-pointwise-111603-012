# 包裹轨迹汇集器

Node.js 本地数据接入项目。包含两条并存的管线：既有来源读取与结构化集合（以 sourceId 保存最新观察），以及面向客服的可重放轨迹接入（只追加事件日志 + 包裹投影）。来源服务和业务存储独立，来源变化不会自动刷新本地集合。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行全部单元与集成测试；`npm run demo` 启动临时来源，演示缺揽收待核对、补传恢复、撤回签收与重放校验，结束时自动清理临时数据，通常两秒内完成。`npm run acceptance` 在临时目录中验证完整接入生命周期。演示数据不访问生产站点。

### 既有集合命令

`npm start -- ingest` 从 `fixtures/records.json` 导入到 `var/records.json`，`npm start -- query` 读取该集合。该管线保留原有“最新观察覆盖”语义，供既有运维入口使用。

### 轨迹接入命令

| 命令 | 作用 |
| --- | --- |
| `npm start -- track [文件]` | 接入一批承运商事件（默认 `fixtures/tracking-events.json`），写入只追加日志并重建投影，重复与冲突计数显式返回 |
| `npm start -- parcels` | 客服包裹列表：当前状态、待核对原因码、时间线长度 |
| `npm start -- parcel <包裹号>` | 单个包裹的完整投影：时间线、撤回、重复、待核对原因与历次接入快照 |
| `npm start -- replay` | 只凭事件日志重建投影并与存储投影逐包裹核对 |

轨迹状态默认写入 `var/tracking/`（`tracking-journal.json` 与 `tracking-projection.json`），可用环境变量 `TRACKING_DIR` 指向其他目录。状态目录属于运行产物。

## 轨迹接入模型

### 三种时间与序号各司其职

- **eventTime（来源时间）**：承运商声称事件发生的时间，是轨迹排序的业务依据。
- **receivedAt（接收时间）**：本地观察到该事件的时间，用于识别补传/迟到，不决定当前状态。
- **sequence（来源序号）**：承运商事件序号，时间线按它排序；缺口与同序号冲突都会暴露。
- **entryId（接入序号）**：本地日志的严格递增序号，保证重放顺序确定、可追溯。

因此“最后收到的一条”永远不会被当成包裹的最后状态：投影只按来源序号和状态机推导。

### 事件日志（`src/tracking/journal.js`）

只追加、不覆盖、不删除。事件身份为 `carrier + eventId`（eventId 仅在承运商内唯一）。重复事件以 `duplicateOf` 引用首次接入条目并保留各自的接收时间与原始载荷；内容冲突时再标记 `conflict`。`retract` 必须携带 `retracts` 引用，它只是一次撤销引用，不是反向物流动作。

### 客服投影（`src/tracking/projection.js`）

投影是纯函数，同一日志必然得到同一结果。每个包裹返回 `status`、`currentStatus`、时间线、撤回与重复追踪，以及 `reasons` 待核对原因。原因码包括：

- `sequence-gap` / `sequence-conflict`：序列缺失或同序号被多个事件占用；
- `missing-collected`：首个有效事件不是揽收；
- `illegal-transition`：违反 collected → in-transit → delivered 的合法路径（重复或倒流）；
- `event-time-out-of-order`：来源时间不递增；
- `unknown-status`：出现契约外状态，保留原文而不猜测；
- `retract-target-missing` / `retract-target-not-status`：撤回引用无法对应一条状态事件；
- `conflicting-duplicate`：同一身份的重复到达内容不一致。

只要存在任何原因，包裹状态即为 `needs-review` 且 `currentStatus` 为 null，不补造看似顺畅的运输过程。有效撤回会把目标事件在时间线中标记为 `retracted` 并从有效轨迹中排除，原始事件仍完整保留在日志中。迟到事件（序号更小却更晚收到）在时间线中标记 `lateArrival`。

### 历史与恢复（`src/tracking/service.js`、`store.js`）

每次接入都在投影文件中追加一张历史快照（含受影响包裹当时的结论与原因）。迟到事件补齐序列后，包裹可以从 `needs-review` 恢复为确定状态，而之前“为什么不能确定”的依据仍可通过 `parcel` 命令或 `getParcel` 追溯。`replay` 从日志重建全部投影并与存储快照核对，任何不一致都会显式报告。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析来源页面并保留原始来源属性，`toCarrierEvents` 把页面事件交给轨迹管线；目前 demo 只导入首批。`src/service.js` 与 `src/repository.js` 维护既有持久集合；`src/operations.js` 是读取该集合的业务消费入口，来源协议见 [CONTRACT.md](CONTRACT.md)。

测试可直接使用随机端口来源，不需要等待真实时间或接入外网（轨迹服务的时钟可注入）。运行录制可用 test 和 demo，无需安装浏览器或外部数据库。`npm start` 或 `npm start -- --help` 查看全部命令。
