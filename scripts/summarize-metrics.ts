import { readFile, writeFile } from 'node:fs/promises';

// Summarize a bounded retained snapshot, or subtract a before-snapshot from it.
// This is an empirical histogram estimate over the burst, not a PromQL rate.
const [afterPath, outputPath, beforePath] = process.argv.slice(2);
if (!afterPath || !outputPath) throw new Error('Usage: npx tsx scripts/summarize-metrics.ts AFTER.prom OUTPUT.json [BEFORE.prom]');
function parse(text: string) {
  const buckets = new Map<number, number>(); const domains: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const bucket = line.match(/^wallet_http_request_duration_seconds_bucket\{([^}]+)\} ([\d.e+-]+)$/);
    if (bucket && /method="POST"/.test(bucket[1]!) && /route="\/transfers"/.test(bucket[1]!)) {
      const le = bucket[1]!.match(/le="([^"]+)"/)?.[1];
      if (le) { const bound = le === '+Inf' ? Infinity : Number(le); buckets.set(bound, (buckets.get(bound) ?? 0) + Number(bucket[2])); }
    }
    const domain = line.match(/^(wallet_(?:transfers_created|transfers_declined_insufficient_funds|idempotent_replays)_total) ([\d.e+-]+)$/);
    if (domain) domains[domain[1]!] = Number(domain[2]);
  }
  return { buckets, domains };
}
const after = parse(await readFile(afterPath, 'utf8'));
const before = beforePath ? parse(await readFile(beforePath, 'utf8')) : { buckets: new Map<number, number>(), domains: {} as Record<string, number> };
const buckets = [...after.buckets].map(([bound, n]) => [bound, n - (before.buckets.get(bound) ?? 0)] as const).sort((a,b) => a[0]-b[0]);
const count = buckets.find(([b]) => b === Infinity)?.[1] ?? 0;
const finite = buckets.filter(([b]) => Number.isFinite(b));
if (count <= 0 || buckets.some(([,n]) => n < 0) || !finite.length) throw new Error('Missing samples or a counter reset; collect a fresh pair of snapshots');
const [maxFinite, finiteCount] = finite.at(-1)!;
const target = count * 0.99;
let previousBound = 0; let previousCount = 0; let estimatedP99: number | null = null;
for (const [bound,n] of finite) {
  if (n >= target) { estimatedP99 = previousBound + (bound-previousBound) * ((target-previousCount)/(n-previousCount)); break; }
  previousBound = bound; previousCount = n;
}
const report = {
  generatedAt: new Date().toISOString(), scope: beforePath ? 'snapshot difference during burst' : 'entire retained process snapshot',
  transferHttpSamples: count, largestFiniteBucketSeconds: maxFinite, samplesBeyondFiniteBuckets: count - finiteCount,
  serverTransferP99HistogramEstimateSeconds: estimatedP99,
  buckets: buckets.map(([bound,n]) => ({ le: Number.isFinite(bound) ? bound : '+Inf', count: n })),
  domainCounters: Object.fromEntries(Object.entries(after.domains).map(([name,n]) => [name,n-(before.domains[name] ?? 0)])),
};
await writeFile(outputPath, `${JSON.stringify(report,null,2)}\n`);
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
if (count > finiteCount) process.exitCode = 2;
