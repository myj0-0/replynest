const DAY_MS = 86_400_000;
export const AVAILABILITY_WINDOW_DAYS = 90;

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function cutoffKey(now, windowDays = AVAILABILITY_WINDOW_DAYS) {
  return dayKey(now - (windowDays - 1) * DAY_MS);
}

function observedRate(value) {
  const up = Number(value?.up ?? 0);
  const total = Number(value?.total ?? 0);
  return total ? Number(((up / total) * 100).toFixed(3)) : null;
}

export function recordAvailability(history, targetId, ok, now = Date.now(), windowDays = AVAILABILITY_WINDOW_DAYS) {
  history[targetId] ??= {};
  const key = dayKey(now);
  const entry = history[targetId][key] ?? { up: 0, total: 0 };
  entry.total += 1;
  if (ok) entry.up += 1;
  history[targetId][key] = entry;
  const cutoff = cutoffKey(now, windowDays);
  for (const date of Object.keys(history[targetId])) {
    if (date < cutoff || date > key) delete history[targetId][date];
  }
  return history;
}

export function availabilitySummary(history, targetId, now = Date.now(), windowDays = AVAILABILITY_WINDOW_DAYS) {
  const cutoff = cutoffKey(now, windowDays);
  const today = dayKey(now);
  const days = Object.entries(history?.[targetId] ?? {})
    .filter(([date]) => date >= cutoff && date <= today)
    .sort(([left], [right]) => left.localeCompare(right));
  const up = days.reduce((sum, [, value]) => sum + Number(value?.up ?? 0), 0);
  const total = days.reduce((sum, [, value]) => sum + Number(value?.total ?? 0), 0);
  return {
    window_days: windowDays,
    coverage_days: days.length,
    sample_count: total,
    monitoring_since: days[0]?.[0] ?? null,
    rate_percent: total ? Number(((up / total) * 100).toFixed(3)) : null
  };
}

export function availabilitySeries(history, targetId, now = Date.now(), windowDays = AVAILABILITY_WINDOW_DAYS) {
  const result = [];
  const values = history?.[targetId] ?? {};
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = dayKey(now - offset * DAY_MS);
    const value = values[date];
    const sampleCount = Number(value?.total ?? 0);
    const ratePercent = observedRate(value);
    result.push({ date, sample_count: sampleCount, rate_percent: ratePercent });
  }
  return result;
}

export function combinedAvailabilitySummary(history, targetIds, now = Date.now(), windowDays = AVAILABILITY_WINDOW_DAYS) {
  const cutoff = cutoffKey(now, windowDays);
  const today = dayKey(now);
  let up = 0;
  let total = 0;
  const observed = new Set();
  for (const targetId of targetIds) {
    for (const [date, value] of Object.entries(history?.[targetId] ?? {})) {
      if (date < cutoff || date > today) continue;
      observed.add(date);
      up += Number(value?.up ?? 0);
      total += Number(value?.total ?? 0);
    }
  }
  const dates = [...observed].sort();
  return {
    window_days: windowDays,
    coverage_days: dates.length,
    sample_count: total,
    monitoring_since: dates[0] ?? null,
    rate_percent: total ? Number(((up / total) * 100).toFixed(3)) : null
  };
}

export function combinedAvailabilitySeries(history, targetIds, now = Date.now(), windowDays = AVAILABILITY_WINDOW_DAYS) {
  const result = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = dayKey(now - offset * DAY_MS);
    let up = 0;
    let total = 0;
    for (const targetId of targetIds) {
      const value = history?.[targetId]?.[date];
      up += Number(value?.up ?? 0);
      total += Number(value?.total ?? 0);
    }
    result.push({
      date,
      sample_count: total,
      rate_percent: total ? Number(((up / total) * 100).toFixed(3)) : null
    });
  }
  return result;
}
