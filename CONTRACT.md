# 来源与消费契约

## 来源

入口 `/carriers/C1/events`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

eventId 仅在 carrier 内唯一，parcelId 是包裹号。sequence 为来源事件序号；eventTime 与 receivedAt 分开。retract 引用原事件，不等于一次反向物流动作。合法路径为 collected -> in-transit -> delivered；中间未知状态不能被补造，撤回和补传都可能改变当前投影。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
