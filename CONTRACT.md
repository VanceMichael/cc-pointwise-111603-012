# 来源与消费契约

## 来源

入口 `/carriers/C1/events`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

eventId 仅在 carrier 内唯一，parcelId 是包裹号。sequence 为来源事件序号；eventTime 与 receivedAt 分开。retract 引用原事件，不等于一次反向物流动作。合法路径为 collected -> in-transit -> delivered；中间未知状态不能被补造，撤回和补传都可能改变当前投影。

## 轨迹事件日志与客服投影

接入侧新增只追加日志（`src/tracking/`），每次接收都保存一条 entry：原始事件放在 `raw`（含 eventTime 来源时间、receivedAt 接收时间），另记本地 recordedAt、batchId 与日志内 sequenceInLog。重复接收新增 entry 而不覆盖；retract 引用通过 `retractions` 与时间线 `state=retracted/retractedBy` 追踪，悬空引用与撤回环上报待核对，不静默丢弃。投影由日志纯函数重放得到，同一份日志必然得到同一份结果，不把“最后收到的一条”当成包裹状态。

投影按 carrier/parcelId 分组并给出 `status` 与 `assurance`：存在 blocking 原因时为 `pending-review`，无有效物流事件时为 `unknown`，否则为 `confirmed`。原因码包括 sequence-gap（1 到最大序号之间的缺失）、sequence-conflict、missing-collected、illegal-transition、delivered-not-final、event-time-out-of-order、dangling-retract、retract-cycle、duplicate-conflict；info 级原因有 duplicate-receipt、late-arrival（首次接收前已有更大序号到达，即补传）、delivery-retracted。原因带 evidence 与中文 message，不补造缺失环节。

检查点（checkpoints）按接收批次重建投影，记录每批新打开（opened）与被消除（resolved）的原因及其 previousBatchId：迟到事件补齐后轨迹恢复为 confirmed，但“之前为什么不能确定”的依据仍可在检查点历史中追溯。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
