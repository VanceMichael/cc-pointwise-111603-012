export const schema = Object.freeze({
  "product": "包裹轨迹汇集器",
  "entity": "轨迹事件",
  "identity": "sourceId",
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "本地物流轨迹的乱序事件整合"
});
