// 客服投影：把只追加的事件日志重放成每个包裹可解释的当前状态。
// 纯函数，不读取时钟或文件；同一份日志必然得到同一份投影，
// 因此迟到事件补齐后可以重新推导出完整轨迹，而不丢失历史依据。

const ALLOWED_TRANSITIONS = Object.freeze({
  collected: new Set(['in-transit']),
  'in-transit': new Set(['delivered']),
  delivered: new Set(),
});

const KNOWN_KINDS = new Set(['collected', 'in-transit', 'delivered']);

const REASON_MESSAGES = Object.freeze({
  'sequence-gap': '来源序号缺失，轨迹存在缺口，无法确认完整运输过程',
  'sequence-conflict': '同一来源序号被多个事件占用，事件身份需要核对',
  'missing-collected': '缺少 collected 揽收起点，轨迹无法从头解释',
  'illegal-transition': '状态跳跃不符合 collected → in-transit → delivered 的合法路径',
  'delivered-not-final': 'delivered 之后又出现新的扫描，来源状态自相矛盾',
  'event-time-out-of-order': '事件来源时间与序号顺序矛盾',
  'dangling-retract': '撤回引用的原事件在日志中不存在，撤回无法落实',
  'retract-cycle': '撤回引用形成循环，撤回关系无法解释',
  'duplicate-conflict': '同一 eventId 收到内容不一致的重复事件，无法判断以哪份为准',
  'duplicate-receipt': '事件被重复接收，已按首次接收去重',
  'late-arrival': '事件晚于更高序号事件到达，属于补传而非新的物流动作',
  'delivery-retracted': '签收已被承运商撤回，当前状态回退到撤回前的最后有效状态',
});

export function reason(code, evidence = {}, severity = 'blocking') {
  return { code, severity, message: REASON_MESSAGES[code] ?? code, evidence: structuredClone(evidence) };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function reasonFingerprint(item) {
  return stableStringify({ code: item.code, evidence: item.evidence });
}

function parcelKeyOf(raw) {
  return `${raw.carrier}/${raw.parcelId}`;
}

function isRetract(raw) {
  return raw.kind === 'retract';
}

// 计算当前仍然生效的撤回：被撤回的撤回本身不再撤回任何事件。
// 先找出撤回引用中的环（环上的撤回永久不生效并上报 retract-cycle），
// 其余引用构成链，用固定点迭代求出生效撤回与其撤回的目标。
function resolveActiveRetracts(canonical) {
  const byId = new Map(canonical.map((raw) => [raw.eventId, raw]));
  const retractEvents = canonical.filter(isRetract);

  const cyclic = new Set();
  for (const start of retractEvents) {
    const seen = new Set();
    let cursor = start;
    while (cursor && isRetract(cursor)) {
      if (seen.has(cursor.eventId)) {
        for (const id of seen) cyclic.add(id);
        break;
      }
      seen.add(cursor.eventId);
      cursor = byId.get(cursor.retracts);
    }
  }

  let active = new Set(
    retractEvents.filter((event) => !cyclic.has(event.eventId)).map((event) => event.eventId),
  );
  let retractedById = new Set();
  for (let guard = 0; guard <= retractEvents.length + 1; guard += 1) {
    const nextRetracted = new Set();
    for (const id of active) {
      const event = byId.get(id);
      if (byId.has(event.retracts)) nextRetracted.add(event.retracts);
    }
    const nextActive = new Set();
    for (const id of active) {
      if (!nextRetracted.has(id)) nextActive.add(id);
    }
    const stable = nextRetracted.size === retractedById.size
      && [...nextRetracted].every((id) => retractedById.has(id))
      && nextActive.size === active.size
      && [...nextActive].every((id) => active.has(id));
    active = nextActive;
    retractedById = nextRetracted;
    if (stable) break;
  }
  return { byId, retractedById, cyclicRetracts: cyclic };
}

function buildParcel(entries) {
  const reasons = [];
  const receipts = new Map(); // eventId -> entry[]（按接收顺序）
  for (const entry of entries) {
    const list = receipts.get(entry.raw.eventId) ?? [];
    list.push(entry);
    receipts.set(entry.raw.eventId, list);
  }

  const canonical = [];
  const duplicates = [];
  for (const [eventId, list] of receipts) {
    const first = list[0];
    canonical.push(first.raw);
    if (list.length > 1) {
      const conflict = list.slice(1).some((entry) => stableStringify(entry.raw) !== stableStringify(first.raw));
      duplicates.push({
        eventId,
        receiptCount: list.length,
        conflict,
        firstRecordedAt: first.recordedAt,
        receiptEntryIds: list.map((entry) => entry.entryId),
      });
      if (conflict) {
        reasons.push(reason('duplicate-conflict', { eventId, receiptCount: list.length }));
      } else {
        reasons.push(reason('duplicate-receipt', { eventId, receiptCount: list.length }, 'info'));
      }
    }
  }

  const { byId, retractedById, cyclicRetracts } = resolveActiveRetracts(canonical);
  for (const eventId of cyclicRetracts) {
    reasons.push(reason('retract-cycle', { eventId }));
  }

  // 悬空撤回：引用目标在日志中根本不存在
  for (const event of canonical.filter(isRetract)) {
    if (!byId.has(event.retracts)) {
      reasons.push(reason('dangling-retract', { eventId: event.eventId, target: event.retracts }));
    }
  }

  // 序号缺口与序号冲突（撤回事件也占用来源序号）
  const bySequence = new Map();
  for (const raw of canonical) {
    const list = bySequence.get(raw.sequence) ?? [];
    list.push(raw);
    bySequence.set(raw.sequence, list);
  }
  const sequences = [...bySequence.keys()].sort((a, b) => a - b);
  // 序号应从 1 起连续；从基准 1 到已观察到的最大序号之间，
  // 任何未出现的序号都是缺口，单事件场景也不例外。
  const missingSequences = [];
  if (sequences.length) {
    for (let value = 1; value < sequences[sequences.length - 1]; value += 1) {
      if (!bySequence.has(value)) missingSequences.push(value);
    }
  }
  if (missingSequences.length) {
    reasons.push(reason('sequence-gap', {
      missing: missingSequences,
      range: { from: 1, to: sequences[sequences.length - 1] },
    }));
  }
  for (const [sequence, list] of bySequence) {
    if (list.length > 1) {
      reasons.push(reason('sequence-conflict', { sequence, eventIds: list.map((raw) => raw.eventId) }));
    }
  }

  // 迟到（补传）：事件第一次接收之前，已有更大序号事件先被接收。
  // 判定基于接收当下，而不是全局最大序号，避免把同批正常顺序误判为迟到。
  const firstSeenAt = new Map();
  const receivedOrder = [];
  for (const entry of entries) {
    receivedOrder.push(entry.raw);
    if (!firstSeenAt.has(entry.raw.eventId)) firstSeenAt.set(entry.raw.eventId, receivedOrder.length - 1);
  }
  const lateArrivals = [];
  for (const [eventId, index] of firstSeenAt) {
    const raw = receivedOrder[index];
    const maxBefore = Math.max(...receivedOrder.slice(0, index).map((item) => item.sequence), -Infinity);
    if (maxBefore > raw.sequence) {
      lateArrivals.push({ eventId, sequence: raw.sequence, receivedAfterSequence: maxBefore });
      reasons.push(reason('late-arrival', { eventId, sequence: raw.sequence, receivedAfterSequence: maxBefore }, 'info'));
    }
  }
  lateArrivals.sort((a, b) => (a.sequence - b.sequence) || a.eventId.localeCompare(b.eventId));

  // 有效物流事件：规范事件、未被撤回、且不是撤回动作本身
  const activeLogistics = canonical
    .filter((raw) => KNOWN_KINDS.has(raw.kind) && !retractedById.has(raw.eventId))
    .sort((a, b) => (a.sequence - b.sequence) || (Date.parse(a.eventTime) - Date.parse(b.eventTime)) || a.eventId.localeCompare(b.eventId));

  // 合法路径与来源时间检查
  let previous = null;
  for (const current of activeLogistics) {
    if (!previous) {
      if (current.kind !== 'collected') {
        reasons.push(reason('missing-collected', { firstEventId: current.eventId, kind: current.kind }));
      }
    } else {
      if (previous.kind === 'delivered') {
        reasons.push(reason('delivered-not-final', { deliveredEventId: previous.eventId, nextEventId: current.eventId, kind: current.kind }));
      } else if (!ALLOWED_TRANSITIONS[previous.kind]?.has(current.kind)) {
        reasons.push(reason('illegal-transition', {
          from: previous.kind,
          to: current.kind,
          fromEventId: previous.eventId,
          toEventId: current.eventId,
        }));
      }
      if (Date.parse(current.eventTime) < Date.parse(previous.eventTime)) {
        reasons.push(reason('event-time-out-of-order', {
          previousEventId: previous.eventId,
          eventId: current.eventId,
          previousEventTime: previous.eventTime,
          eventTime: current.eventTime,
        }));
      }
    }
    previous = current;
  }

  // 撤回落实到时间线：记录被撤回的签收等事件
  const retractions = canonical.filter(isRetract)
    .sort((a, b) => (a.sequence - b.sequence) || a.eventId.localeCompare(b.eventId))
    .map((raw) => ({
    eventId: raw.eventId,
    retracts: raw.retracts,
    eventTime: raw.eventTime,
    receivedAt: raw.receivedAt,
    active: !retractedById.has(raw.eventId),
    retractedBy: retractedById.has(raw.eventId)
      ? canonical.find((candidate) => isRetract(candidate) && candidate.retracts === raw.eventId)?.eventId ?? null
      : null,
    targetKnown: byId.has(raw.retracts),
  }));

  const retractedDeliveries = canonical
    .filter((raw) => raw.kind === 'delivered' && retractedById.has(raw.eventId))
    .map((raw) => raw.eventId);
  for (const eventId of retractedDeliveries) {
    reasons.push(reason('delivery-retracted', {
      eventId,
      fallback: activeLogistics.length ? activeLogistics[activeLogistics.length - 1].kind : 'unknown',
    }, 'info'));
  }

  const blocking = reasons.filter((item) => item.severity === 'blocking');
  const status = activeLogistics.length ? activeLogistics[activeLogistics.length - 1].kind : 'unknown';
  const assurance = blocking.length ? 'pending-review' : (activeLogistics.length ? 'confirmed' : 'unknown');

  const timeline = canonical
    .filter((raw) => !isRetract(raw))
    .sort((a, b) => (a.sequence - b.sequence) || (Date.parse(a.eventTime) - Date.parse(b.eventTime)) || a.eventId.localeCompare(b.eventId))
    .map((raw) => ({
      eventId: raw.eventId,
      sequence: raw.sequence,
      kind: raw.kind,
      eventTime: raw.eventTime,
      receivedAt: raw.receivedAt,
      state: retractedById.has(raw.eventId) ? 'retracted' : 'active',
      retractedBy: retractedById.has(raw.eventId)
        ? canonical.find((candidate) => isRetract(candidate) && candidate.retracts === raw.eventId)?.eventId ?? null
        : null,
      receiptCount: receipts.get(raw.eventId).length,
      firstRecordedAt: receipts.get(raw.eventId)[0].recordedAt,
    }));

  const firstEntry = entries[0];
  return {
    parcelId: firstEntry.raw.parcelId,
    carrier: firstEntry.raw.carrier,
    key: parcelKeyOf(firstEntry.raw),
    status,
    assurance,
    reasons: reasons.sort((a, b) => a.code.localeCompare(b.code) || reasonFingerprint(a).localeCompare(reasonFingerprint(b))),
    timeline,
    retractions,
    duplicates: duplicates.sort((a, b) => a.eventId.localeCompare(b.eventId)),
    lateArrivals,
    observedSequences: sequences,
    counts: {
      entries: entries.length,
      canonicalEvents: canonical.length,
      activeEvents: activeLogistics.length,
      retractedEvents: [...retractedById].filter((id) => !isRetract(byId.get(id))).length,
      retractEvents: retractions.length,
      duplicateReceipts: duplicates.reduce((sum, item) => sum + item.receiptCount - 1, 0),
    },
  };
}

// 从完整日志构建客服投影。
export function buildProjection(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = parcelKeyOf(entry.raw);
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const parcels = [...groups.values()]
    .map((group) => buildParcel(group))
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    parcels,
    totals: {
      entries: entries.length,
      parcels: parcels.length,
      pendingReview: parcels.filter((parcel) => parcel.assurance === 'pending-review').length,
    },
  };
}

// 按接收批次生成检查点：保留每一批当时看到的状态、
// 新打开的待核对原因、以及本批被消除（补齐/撤回落实）的原因。
export function buildCheckpoints(entries) {
  const batches = new Map();
  for (const entry of entries) {
    const list = batches.get(entry.batchId) ?? [];
    list.push(entry);
    batches.set(entry.batchId, list);
  }
  const checkpoints = [];
  const accumulated = [];
  // fingerprint -> { reason, batchId }，按包裹分别跟踪
  const openByParcel = new Map();

  for (const [batchId, batchEntries] of batches) {
    accumulated.push(...batchEntries);
    const projection = buildProjection(accumulated);
    const parcelViews = {};
    for (const parcel of projection.parcels) {
      const open = openByParcel.get(parcel.key) ?? new Map();
      const currentFingerprints = new Set(parcel.reasons.map(reasonFingerprint));
      const resolved = [];
      for (const [fingerprint, tracked] of open) {
        if (!currentFingerprints.has(fingerprint)) {
          resolved.push({ ...tracked.reason, previousBatchId: tracked.batchId });
          open.delete(fingerprint);
        }
      }
      const opened = [];
      for (const item of parcel.reasons) {
        const fingerprint = reasonFingerprint(item);
        if (!open.has(fingerprint)) {
          opened.push(structuredClone(item));
          open.set(fingerprint, { reason: structuredClone(item), batchId });
        }
      }
      openByParcel.set(parcel.key, open);
      parcelViews[parcel.key] = {
        parcelId: parcel.parcelId,
        carrier: parcel.carrier,
        status: parcel.status,
        assurance: parcel.assurance,
        reasons: parcel.reasons,
        opened,
        resolved,
      };
    }
    checkpoints.push({
      batchId,
      recordedAt: batchEntries[0].recordedAt,
      entryCount: batchEntries.length,
      parcels: parcelViews,
    });
  }
  return checkpoints;
}
