// 客服投影：从可重放的事件日志推导每个包裹的可解释状态。
// 投影是纯函数，给定同样的日志条目必然得到同样的结果，因此随时可以重放校验。
// 绝不把“最后收到的一条”当成最后状态：轨迹按来源序号排序，
// 序列缺失、状态机矛盾、撤回目标缺失等情况一律给出待核对原因，
// 不补造看似顺畅的运输过程。

const STATE_RANK = Object.freeze({
  collected: 1,
  'in-transit': 2,
  delivered: 3,
});
const KNOWN_KINDS = new Set(['collected', 'in-transit', 'delivered', 'retract']);
const STATUS_EVENTS = new Set(['collected', 'in-transit', 'delivered']);

// 依据完整日志构建全部包裹的当前投影。
export function buildProjections(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.parcelId)) groups.set(entry.parcelId, []);
    groups.get(entry.parcelId).push(entry);
  }
  const parcels = [...groups.entries()]
    .map(([parcelId, group]) => buildParcelProjection(parcelId, group))
    .sort((left, right) => left.parcelId.localeCompare(right.parcelId));
  return {
    version: 1,
    parcelCount: parcels.length,
    needsReviewCount: parcels.filter((parcel) => parcel.status === 'needs-review').length,
    parcels,
  };
}

export function buildParcelProjection(parcelId, group) {
  const reasons = [];
  const addReason = (code, detail) => reasons.push({ code, ...detail });

  const canonical = new Map();
  const duplicates = [];
  // 1) 重复事件：保留首次接入为准，重复与冲突都可追踪。
  for (const entry of group) {
    const key = `${entry.carrier}/${entry.eventId}`;
    const first = canonical.get(key);
    if (!first) {
      canonical.set(key, entry);
    } else {
      duplicates.push({
        entryId: entry.entryId,
        eventId: entry.eventId,
        carrier: entry.carrier,
        duplicateOf: entry.duplicateOf ?? first.entryId,
        conflict: entry.conflict === true,
        receivedAt: entry.receivedAt,
      });
      if (entry.conflict === true) {
        addReason('conflicting-duplicate', {
          carrier: entry.carrier,
          eventId: entry.eventId,
          firstEntryId: first.entryId,
          duplicateEntryId: entry.entryId,
        });
      }
    }
  }
  const unique = [...canonical.values()];

  // 2) 撤回：retract 不是反向物流动作，只是引用并撤销一次扫错的事件。
  const retractedKeys = new Set();
  const retractions = [];
  for (const entry of unique.filter((item) => item.kind === 'retract')) {
    const targetKey = `${entry.carrier}/${entry.retracts ?? ''}`;
    const target = canonical.get(targetKey);
    const retraction = {
      entryId: entry.entryId,
      eventId: entry.eventId,
      carrier: entry.carrier,
      retracts: entry.retracts,
      targetEntryId: target?.entryId ?? null,
      effective: false,
    };
    if (!target) {
      addReason('retract-target-missing', {
        carrier: entry.carrier,
        eventId: entry.eventId,
        retracts: entry.retracts,
      });
    } else if (target.kind === 'retract') {
      addReason('retract-target-not-status', {
        carrier: entry.carrier,
        eventId: entry.eventId,
        retracts: entry.retracts,
        targetKind: target.kind,
      });
    } else {
      retractedKeys.add(targetKey);
      retraction.effective = true;
    }
    retractions.push(retraction);
  }

  const active = unique.filter((entry) => {
    if (entry.kind === 'retract') return false;
    if (retractedKeys.has(`${entry.carrier}/${entry.eventId}`)) return false;
    return true;
  });

  // 3) 序号检查：来源序号是轨迹顺序的权威，缺口必须显式暴露。
  const sequenceOwners = new Map();
  for (const entry of active) {
    if (!sequenceOwners.has(entry.sequence)) sequenceOwners.set(entry.sequence, []);
    sequenceOwners.get(entry.sequence).push(entry);
  }
  for (const [sequence, owners] of sequenceOwners) {
    if (owners.length > 1) {
      addReason('sequence-conflict', {
        sequence,
        eventIds: owners.map((entry) => entry.eventId),
      });
    }
  }
  const sequences = [...sequenceOwners.keys()].sort((a, b) => a - b);
  const maxSequence = sequences.at(-1);
  const present = new Set(sequences);
  const missing = [];
  if (maxSequence !== undefined) {
    for (let sequence = 1; sequence < maxSequence; sequence += 1) {
      if (!present.has(sequence)) missing.push(sequence);
    }
  }
  if (missing.length) {
    addReason('sequence-gap', { missingSequences: missing, maxSequence });
  }

  // 4) 按序号（同序号按接入序号）排列有效事件，检查合法路径与时间一致性。
  const ordered = [...active].sort((left, right) =>
    (left.sequence - right.sequence) || (left.entryId - right.entryId));

  let lastRank = 0;
  let lastTime = null;
  let lastEntry = null;
  let firstStatusSeen = false;
  for (const entry of ordered) {
    if (!KNOWN_KINDS.has(entry.kind)) {
      addReason('unknown-status', { eventId: entry.eventId, kind: entry.kind, sequence: entry.sequence });
      continue;
    }
    if (!firstStatusSeen) {
      firstStatusSeen = true;
      if (entry.kind !== 'collected') {
        addReason('missing-collected', { firstEventId: entry.eventId, firstKind: entry.kind });
      }
    }
    const rank = STATE_RANK[entry.kind];
    if (rank !== undefined && lastRank !== 0) {
      if (rank === lastRank) {
        addReason('illegal-transition', {
          from: lastEntry.kind,
          to: entry.kind,
          eventId: entry.eventId,
          sequence: entry.sequence,
        });
      } else if (rank < lastRank) {
        addReason('illegal-transition', {
          from: lastEntry.kind,
          to: entry.kind,
          eventId: entry.eventId,
          sequence: entry.sequence,
        });
      }
    }
    if (rank !== undefined) {
      lastRank = rank;
      lastEntry = entry;
    }
    const time = Date.parse(entry.eventTime);
    if (lastTime !== null && time < lastTime) {
      addReason('event-time-out-of-order', {
        eventId: entry.eventId,
        eventTime: entry.eventTime,
        previousEventId: lastEntry?.eventId ?? null,
      });
    }
    lastTime = time;
  }

  // 5) 当前状态只来自通过序号与状态机检查后的有效事件，不看接收先后。
  const timeline = buildTimeline(unique, retractedKeys, group);
  const statusEvents = ordered.filter((entry) => STATUS_EVENTS.has(entry.kind));
  const terminal = statusEvents.at(-1) ?? null;
  const currentStatus = reasons.length ? null : (terminal?.kind ?? null);
  const latestEntryId = group.reduce((max, entry) => Math.max(max, entry.entryId), 0);

  return {
    parcelId,
    carriers: [...new Set(group.map((entry) => entry.carrier))].sort(),
    status: reasons.length ? 'needs-review' : (currentStatus ?? 'unknown'),
    currentStatus,
    needsReview: reasons.length > 0,
    reasons,
    timeline,
    retractions,
    duplicates,
    retractedEventIds: [...retractedKeys].map((key) => key.split('/')[1]),
    observed: {
      eventCount: unique.length,
      activeEventCount: active.length,
      sequenceRange: maxSequence === undefined ? null : {
        min: sequences[0],
        max: maxSequence,
        missing: missing,
      },
      firstEntryId: group.reduce((min, entry) => Math.min(min, entry.entryId), Infinity),
      latestEntryId,
      lastReceivedAt: group.map((entry) => entry.receivedAt).sort().at(-1) ?? null,
    },
  };
}

// 时间线按来源序号排列（撤回与重复不参与排序），并保留每条记录的接收依据，
// 让客服能区分“事件何时发生”和“我们何时知道”。
function buildTimeline(unique, retractedKeys, group) {
  const receivedFirst = new Map();
  for (const entry of [...group].sort((a, b) => a.entryId - b.entryId)) {
    const key = `${entry.carrier}/${entry.eventId}`;
    if (!receivedFirst.has(key)) receivedFirst.set(key, entry.receivedAt);
  }
  const statusEntries = unique
    .filter((entry) => entry.kind !== 'retract')
    .sort((a, b) => (a.sequence - b.sequence) || (a.entryId - b.entryId));

  const rows = statusEntries.map((entry) => {
    const key = `${entry.carrier}/${entry.eventId}`;
    const retracted = retractedKeys.has(key);
    const late = isLateArrival(entry, statusEntries);
    return {
      eventId: entry.eventId,
      carrier: entry.carrier,
      sequence: entry.sequence,
      kind: entry.kind,
      eventTime: entry.eventTime,
      receivedAt: entry.receivedAt,
      firstReceivedAt: receivedFirst.get(key),
      entryId: entry.entryId,
      retracted,
      lateArrival: late,
      duplicateArrivals: group
        .filter((candidate) => `${candidate.carrier}/${candidate.eventId}` === key && candidate.duplicate)
        .map((candidate) => ({ entryId: candidate.entryId, receivedAt: candidate.receivedAt, conflict: candidate.conflict === true })),
    };
  });

  const retractRows = unique
    .filter((entry) => entry.kind === 'retract')
    .map((entry) => ({
      eventId: entry.eventId,
      carrier: entry.carrier,
      sequence: entry.sequence,
      kind: 'retract',
      eventTime: entry.eventTime,
      receivedAt: entry.receivedAt,
      firstReceivedAt: receivedFirst.get(`${entry.carrier}/${entry.eventId}`),
      entryId: entry.entryId,
      retracts: entry.retracts,
    }));

  return [...rows, ...retractRows].sort((a, b) => (a.sequence - b.sequence) || (a.entryId - b.entryId));
}

// 迟到判定：该事件的接收时间晚于序号更大的有效事件的接收时间，
// 即“业务上更早发生、却更晚才到达”的补传事件。
function isLateArrival(entry, orderedStatusEntries) {
  const ownReceived = Date.parse(entry.receivedAt);
  return orderedStatusEntries.some((other) =>
    other.sequence > entry.sequence
    && Date.parse(other.receivedAt) < ownReceived);
}
