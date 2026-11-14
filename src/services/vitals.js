// Sinais vitais do servidor para o HUD: CPU, memória, disco e rede (Linux/VPS; no Windows mostra o que der).
let os = null; let fs = null;
try { os = process.getBuiltinModule?.('node:os') || null; fs = process.getBuiltinModule?.('node:fs') || null; } catch { /* Worker */ }

let lastCpu = null; let lastNet = null;

function cpuPct() {
  if (!os) return null;
  const cpus = os.cpus(); if (!cpus?.length) return null;
  const t = cpus.reduce((a, c) => { const tot = Object.values(c.times).reduce((x, y) => x + y, 0); return { idle: a.idle + c.times.idle, total: a.total + tot }; }, { idle: 0, total: 0 });
  let pct;
  if (lastCpu && t.total > lastCpu.total) pct = 100 * (1 - (t.idle - lastCpu.idle) / (t.total - lastCpu.total));
  else pct = Math.min(100, (os.loadavg()[0] / cpus.length) * 100);
  lastCpu = t;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function netRate() {
  if (!fs) return null;
  try {
    const txt = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0; let tx = 0;
    for (const line of txt.split('\n').slice(2)) {
      const [name, rest] = line.split(':'); if (!rest || /^\s*(lo|docker|veth|br-)/.test(name)) continue;
      const f = rest.trim().split(/\s+/).map(Number); rx += f[0] || 0; tx += f[8] || 0;
    }
    const t = Date.now(); let out = { up_kbs: 0, down_kbs: 0 };
    if (lastNet && t > lastNet.t) { const s = (t - lastNet.t) / 1000; out = { down_kbs: Math.max(0, Math.round((rx - lastNet.rx) / 1024 / s)), up_kbs: Math.max(0, Math.round((tx - lastNet.tx) / 1024 / s)) }; }
    lastNet = { rx, tx, t };
    return out;
  } catch { return null; }
}

function disk(dir) {
  if (!fs?.statfsSync) return null;
  try { const s = fs.statfsSync(dir); const total = s.blocks * s.bsize; const free = s.bavail * s.bsize; return { pct: Math.round(100 * (1 - free / total)), free_gb: Math.round(free / 1e9 * 10) / 10, total_gb: Math.round(total / 1e9) }; } catch { return null; }
}

export function vitals(dataDir = '/') {
  const mem = os ? { pct: Math.round(100 * (1 - os.freemem() / os.totalmem())), total_gb: Math.round(os.totalmem() / 1e9 * 10) / 10 } : null;
  // memória "disponível" de verdade no Linux (o freemem conta o cache como usado)
  if (mem && fs) { try { const mi = fs.readFileSync('/proc/meminfo', 'utf8'); const tot = Number(/MemTotal:\s+(\d+)/.exec(mi)?.[1]); const av = Number(/MemAvailable:\s+(\d+)/.exec(mi)?.[1]); if (tot && av) mem.pct = Math.round(100 * (1 - av / tot)); } catch { /* */ } }
  return {
    at: new Date().toISOString(),
    cpu: cpuPct(), cores: os?.cpus()?.length || null, load: os ? Math.round(os.loadavg()[0] * 100) / 100 : null,
    mem, disk: disk(dataDir), net: netRate(),
    uptime_h: os ? Math.round(os.uptime() / 360) / 10 : null, proc_mb: Math.round(process.memoryUsage().rss / 1e6),
    host: os?.hostname?.() || null,
  };
}
