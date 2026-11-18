# 来源与消费契约

## 来源

入口 `/carriers/C1/events`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

eventId 仅在 carrier 内唯一，parcelId 是包裹号。sequence 为来源事件序号；eventTime 与 receivedAt 分开。retract 引用原事件，不等于一次反向物流动作。合法路径为 collected -> in-transit -> delivered；中间未知状态不能被补造，撤回和补传都可能改变当前投影。

### 三种时间与序号的语义

- eventTime 是承运商声称的事件发生时间，用于业务轨迹；receivedAt 是本地接收时间，用于识别补传与迟到。两者必须分别保存，不能互相覆盖。
- sequence 是来源给的事件序号，时间线顺序以它为准；本地接入另维护严格递增的 entryId，保证只追加日志的重放顺序确定。
- 补传事件的特征是 sequence 更小而 receivedAt 更晚；接入方不得用接收顺序顶替业务顺序。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。

### 轨迹接入的消费保证

- 事件日志只追加：任何事件（含重复、撤回、迟到补传）都保留原始载荷、eventTime、receivedAt 与 entryId；重复事件通过 duplicateOf 引用首次接入，冲突另行标记。
- 客服投影不得把“最后收到的一条”当作最后状态。当前状态只由未撤回的有效事件按 sequence 与合法路径推导。
- 序列缺失、同序号冲突、非法状态跳转、来源时间倒流、未知状态、撤回目标缺失或指向非状态事件，都必须以显式待核对原因返回；此时包裹为 needs-review，不补造中间过程。
- 撤回只撤销其引用的目标事件：目标在时间线中保留并标记 retracted，撤回本身不是物流状态；撤回引用无法解析时进入待核对。
- 每次接入产生一张历史快照。迟到事件补齐后投影可恢复为确定状态，但历史快照必须保留此前不能确定的原因。
- 投影必须可由事件日志完整重放，重放结果与存储投影逐包裹核对，不一致时显式报告而非静默修正。
