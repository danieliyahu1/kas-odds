// Dependency-free Prometheus metrics registry.
//
// The application runs without npm runtime dependencies, so this module
// implements the small subset of the Prometheus client contract the service
// needs: counters, gauges, and histograms with bounded label cardinality, plus
// a text exposition renderer. Labels must never carry wallet addresses, game
// ids, transaction ids, request ids, or raw URLs.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function labelKey(labels) {
  return Object.keys(labels).sort().map((name) => `${name}=${labels[name]}`).join('\u0001');
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels) {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return '';
  return `{${names.map((name) => `${name}="${escapeLabel(labels[name])}"`).join(',')}}`;
}

function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

export class Metrics {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.startTimeMs = Date.now();
  }

  increment(name, help, labels = {}, value = 1) {
    const id = `${name}\u0001${labelKey(labels)}`;
    const entry = this.counters.get(id) ?? { name, help, labels, value: 0 };
    entry.value += value;
    this.counters.set(id, entry);
  }

  set(name, help, labels = {}, value) {
    const id = `${name}\u0001${labelKey(labels)}`;
    this.gauges.set(id, { name, help, labels, value: Number(value) });
  }

  observe(name, help, labels = {}, value, buckets = DURATION_BUCKETS) {
    const id = `${name}\u0001${labelKey(labels)}`;
    const entry = this.histograms.get(id) ?? {
      name,
      help,
      labels,
      buckets: [...buckets],
      counts: new Array(buckets.length).fill(0),
      sum: 0,
      count: 0,
    };
    entry.sum += value;
    entry.count += 1;
    for (let index = 0; index < entry.buckets.length; index += 1) {
      if (value <= entry.buckets[index]) entry.counts[index] += 1;
    }
    this.histograms.set(id, entry);
  }

  recordHttp({ method, route, status, durationSeconds }) {
    const labels = { method, route, status: String(status) };
    this.increment('kasodds_http_requests_total', 'Total HTTP requests handled.', labels);
    this.observe('kasodds_http_request_duration_seconds', 'HTTP request duration in seconds.', { method, route }, durationSeconds);
    if (status >= 400) {
      this.increment('kasodds_http_errors_total', 'Total HTTP responses with a 4xx or 5xx status.', labels);
    }
  }

  recordRpc({ operation, outcome, durationSeconds }) {
    this.increment('kasodds_rpc_requests_total', 'Total Kaspa wRPC calls.', { operation, outcome });
    this.observe('kasodds_rpc_request_duration_seconds', 'Kaspa wRPC call duration in seconds.', { operation }, durationSeconds);
  }

  recordStorage({ operation, outcome, durationSeconds }) {
    this.increment('kasodds_storage_operations_total', 'Total backend store operations.', { operation, outcome });
    this.observe('kasodds_storage_operation_duration_seconds', 'Backend store operation duration in seconds.', { operation }, durationSeconds);
  }

  recordGameEvent(event) {
    this.increment('kasodds_game_events_total', 'Backend game lifecycle events.', { event });
  }

  recordPageVisit() {
    this.increment('kasodds_page_visits_total', 'Number of homepage loads.', {});
  }

  setMatchmakingWaiting(value) {
    this.set('kasodds_matchmaking_waiting', 'Number of matchmaking sessions waiting for a rival.', {}, value);
  }

  setRelayEntries(value) {
    this.set('kasodds_relay_entries', 'Number of live relay entries held in memory.', {}, value);
  }

  recordFeedback({ outcome }) {
    this.increment('kasodds_feedback_total', 'Anonymous user feedback submissions.', { outcome });
  }

  setProductInfo(version) {
    this.set('kasodds_app_info', 'Application build information.', { version }, 1);
  }

  render() {
    const lines = [];
    const emitSeries = (map, type) => {
      const groups = new Map();
      for (const entry of map.values()) {
        if (!groups.has(entry.name)) groups.set(entry.name, []);
        groups.get(entry.name).push(entry);
      }
      for (const name of [...groups.keys()].sort()) {
        const entries = groups.get(name).sort((left, right) => labelKey(left.labels).localeCompare(labelKey(right.labels)));
        lines.push(`# HELP ${name} ${entries[0].help}`);
        lines.push(`# TYPE ${name} ${type}`);
        for (const entry of entries) {
          lines.push(`${name}${formatLabels(entry.labels)} ${formatNumber(entry.value)}`);
        }
      }
    };

    emitSeries(this.counters, 'counter');
    emitSeries(this.gauges, 'gauge');

    const histogramGroups = new Map();
    for (const entry of this.histograms.values()) {
      if (!histogramGroups.has(entry.name)) histogramGroups.set(entry.name, []);
      histogramGroups.get(entry.name).push(entry);
    }
    for (const name of [...histogramGroups.keys()].sort()) {
      const entries = histogramGroups.get(name).sort((left, right) => labelKey(left.labels).localeCompare(labelKey(right.labels)));
      lines.push(`# HELP ${name} ${entries[0].help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const entry of entries) {
        for (let index = 0; index < entry.buckets.length; index += 1) {
          lines.push(`${name}_bucket${formatLabels({ ...entry.labels, le: entry.buckets[index] })} ${entry.counts[index]}`);
        }
        lines.push(`${name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
        lines.push(`${name}_sum${formatLabels(entry.labels)} ${formatNumber(entry.sum)}`);
        lines.push(`${name}_count${formatLabels(entry.labels)} ${entry.count}`);
      }
    }

    this.#appendProcessMetrics(lines);
    return `${lines.join('\n')}\n`;
  }

  #appendProcessMetrics(lines) {
    if (typeof process === 'undefined') return;
    const uptimeSeconds = (Date.now() - this.startTimeMs) / 1000;
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const cpuSeconds = (cpu.user + cpu.system) / 1_000_000;
    lines.push('# HELP kasodds_process_start_time_seconds Start time of the process since unix epoch in seconds.');
    lines.push('# TYPE kasodds_process_start_time_seconds gauge');
    lines.push(`kasodds_process_start_time_seconds ${formatNumber(this.startTimeMs / 1000)}`);
    lines.push('# HELP kasodds_process_uptime_seconds Process uptime in seconds.');
    lines.push('# TYPE kasodds_process_uptime_seconds gauge');
    lines.push(`kasodds_process_uptime_seconds ${formatNumber(uptimeSeconds)}`);
    lines.push('# HELP kasodds_process_cpu_seconds_total Total user and system CPU time spent in seconds.');
    lines.push('# TYPE kasodds_process_cpu_seconds_total counter');
    lines.push(`kasodds_process_cpu_seconds_total ${formatNumber(cpuSeconds)}`);
    lines.push('# HELP kasodds_process_resident_memory_bytes Resident memory size in bytes.');
    lines.push('# TYPE kasodds_process_resident_memory_bytes gauge');
    lines.push(`kasodds_process_resident_memory_bytes ${memory.rss}`);
    lines.push('# HELP kasodds_nodejs_heap_used_bytes Node.js heap used in bytes.');
    lines.push('# TYPE kasodds_nodejs_heap_used_bytes gauge');
    lines.push(`kasodds_nodejs_heap_used_bytes ${memory.heapUsed}`);
    lines.push('# HELP kasodds_nodejs_heap_total_bytes Node.js heap total in bytes.');
    lines.push('# TYPE kasodds_nodejs_heap_total_bytes gauge');
    lines.push(`kasodds_nodejs_heap_total_bytes ${memory.heapTotal}`);
  }
}

export const noopMetrics = {
  increment() {},
  set() {},
  observe() {},
  recordHttp() {},
  recordRpc() {},
  recordStorage() {},
  recordGameEvent() {},
  recordPageVisit() {},
  setMatchmakingWaiting() {},
  setRelayEntries() {},
  recordFeedback() {},
  setProductInfo() {},
  render() {
    return '';
  },
};

export function withRpcMetrics(target, metrics) {
  const instrumented = new Set(['getBlockDagInfo', 'getUtxosByAddresses', 'getFeeEstimate', 'submitSafeJson']);
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function' || !instrumented.has(property)) return value;
      return async (...args) => {
        const startedAt = performance.now();
        let outcome = 'success';
        try {
          return await value.apply(object, args);
        } catch (error) {
          outcome = 'error';
          throw error;
        } finally {
          metrics.recordRpc({ operation: String(property), outcome, durationSeconds: (performance.now() - startedAt) / 1000 });
        }
      };
    },
  });
}
