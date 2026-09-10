import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBurstClient } from './burst-client.js';

interface WalletResponse { id: string; balance_paise: string }
interface TransferResponse { id: string; from: string; to: string; amount_paise: string; status: 'completed' | 'declined'; decline_reason: string | null }
export interface BurstOptions { walletRequests?: number; replayRequests?: number; contentionRequests?: number; exhaustionRequests?: number; timeoutMs?: number; maxRetries?: number }

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function count(value: number | undefined, fallback: number, name: string, minimum = 1): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < minimum || n > 5000) throw new Error(`${name} must be an integer from ${minimum} to 5000`);
  return n;
}
const total = (wallets: WalletResponse[]) => wallets.reduce((sum, wallet) => sum + BigInt(wallet.balance_paise), 0n);

// Await every request even on failure so evidence includes the whole burst.
async function batch<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) throw new Error(`${failures.length}/${tasks.length} requests failed; first: ${String((failures[0] as PromiseRejectedResult).reason)}`);
  return results.map(r => (r as PromiseFulfilledResult<T>).value);
}

export async function runBurst(rawBaseUrl: string, options: BurstOptions = {}) {
  const url = new URL(rawBaseUrl);
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Use a plain HTTP(S) base URL without credentials, query or fragment');
  const baseUrl = url.href.replace(/\/$/, '');
  const walletRequests = count(options.walletRequests, 50, 'walletRequests');
  const replayRequests = count(options.replayRequests, 30, 'replayRequests');
  const contentionRequests = count(options.contentionRequests, 300, 'contentionRequests', 6);
  const exhaustionRequests = count(options.exhaustionRequests, 50, 'exhaustionRequests', 9);
  const timeoutMs = options.timeoutMs ?? 120_000;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 300_000, 'timeoutMs must be 100–300000');
  const maxRetries = options.maxRetries ?? 2;
  check(Number.isSafeInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 5, 'maxRetries must be 0–5');
  const client = createBurstClient(baseUrl, timeoutMs, maxRetries);
  const startedAt = new Date().toISOString(); const start = performance.now();
  const runId = randomUUID();
  const phases: Record<string, number> = {}; let phaseStarted = start;
  const finishPhase = (name: string) => { phases[name] = Math.round(performance.now() - phaseStarted); phaseStarted = performance.now(); };
  const getWallet = (wallet: WalletResponse, user: string) => client.request<WalletResponse>('GET', `/wallets/${wallet.id}`, user);
  const createWallet = (user: string, balance: number) => client.request<WalletResponse>('POST', '/wallets', user, { initial_balance_paise: balance });
  const command = (from: string, to: string, amount: number, key = randomUUID()) => ({ from, to, amount_paise: amount, idempotency_key: key });
  const post = (user: string, body: ReturnType<typeof command>) => client.request<TransferResponse>('POST', '/transfers', user, body);
  try {
    const health = await client.request<{ status: string; revision?: string }>('GET', '/health');
    check(health.status === 'ok', 'Service is not ready');
    finishPhase('readiness');
    // Tokens are independent secrets, never derivable from the public run ID.
    const concurrentUser = randomUUID();
    const concurrentResponses = await batch(Array.from({ length: walletRequests }, () => createWallet(concurrentUser, 10_000)));
    const uniqueWallets = new Set(concurrentResponses.map(w => w.id)).size;
    check(uniqueWallets === 1 && concurrentResponses.every(w => w.balance_paise === '10000'), 'Concurrent wallet creation broke uniqueness or initial funding');
    check((await createWallet(concurrentUser, 99_999)).balance_paise === '10000', 'Wallet creation replay changed balance');
    finishPhase('walletCreates');

    const users = Array.from({ length: 3 }, () => randomUUID());
    const wallets = await batch(users.map(user => createWallet(user, 10_000)));
    const [alice, bob] = wallets;
    check(alice && bob, 'Missing probe wallets');
    const retryBody = command(alice.id, bob.id, 1000, `retry-${runId}`);
    const retryResponses = await batch(Array.from({ length: replayRequests }, () => post(users[0]!, retryBody)));
    const uniqueResponses = new Set(retryResponses.map(r => JSON.stringify(r))).size;
    check(uniqueResponses === 1 && retryResponses[0]?.status === 'completed', 'Idempotency storm did not return one completed result');
    const sourceAfterRetry = await getWallet(alice, users[0]!);
    const destinationAfterRetry = await getWallet(bob, users[1]!);
    check(sourceAfterRetry.balance_paise === '9000' && destinationAfterRetry.balance_paise === '11000', 'Retry storm changed balances incorrectly');
    finishPhase('identicalTransfers');

    const before = await batch(wallets.map((w, i) => getWallet(w, users[i]!)));
    const totalBefore = total(before);
    const commands = Array.from({ length: contentionRequests }, (_, i) => {
      const source = i % 3; const destination = (source + 1 + (i % 2)) % 3;
      return { user: users[source]!, body: command(wallets[source]!.id, wallets[destination]!.id, i % 9 === 0 ? 50_000 : 3, `contention-${runId}-${i}`) };
    });
    const results = await batch(commands.map(c => post(c.user, c.body)));
    check(new Set(results.map(t => t.id)).size === contentionRequests, 'Distinct keys returned duplicate transfer IDs');
    const expected = new Map(before.map(w => [w.id, BigInt(w.balance_paise)]));
    for (const [i, result] of results.entries()) {
      const body = commands[i]!.body;
      check(result.from === body.from && result.to === body.to && result.amount_paise === String(body.amount_paise), 'Transfer response does not match command');
      if (body.amount_paise === 50_000) check(result.status === 'declined' && result.decline_reason === 'insufficient_funds', 'Expected clean overdraft decline');
      else check(result.status === 'completed', 'Affordable contention transfer did not complete');
      if (result.status === 'completed') {
        expected.set(body.from, expected.get(body.from)! - BigInt(body.amount_paise));
        expected.set(body.to, expected.get(body.to)! + BigInt(body.amount_paise));
      }
    }
    const after = await batch(wallets.map((w, i) => getWallet(w, users[i]!)));
    for (const wallet of after) check(BigInt(wallet.balance_paise) === expected.get(wallet.id), 'Per-wallet contention balance mismatch');
    const totalAfter = total(after); const minimumBalance = after.reduce((min, w) => BigInt(w.balance_paise) < min ? BigInt(w.balance_paise) : min, BigInt(after[0]!.balance_paise));
    check(totalAfter === totalBefore && minimumBalance >= 0n, 'Conservation or non-negative balance invariant failed');
    finishPhase('contention');

    const smallUsers = [randomUUID(), randomUUID()];
    const small = await batch([createWallet(smallUsers[0]!, 25), createWallet(smallUsers[1]!, 0)]);
    const exhaustBodies = Array.from({ length: exhaustionRequests }, (_, i) => command(small[0]!.id, small[1]!.id, 3, `exhaust-${runId}-${i}`));
    const exhausted = await batch(exhaustBodies.map(body => post(smallUsers[0]!, body)));
    const completed = exhausted.filter(r => r.status === 'completed').length;
    const declined = exhausted.filter(r => r.status === 'declined' && r.decline_reason === 'insufficient_funds').length;
    check(completed === 8 && declined === exhaustionRequests - 8, 'Competing debits did not exhaust balance cleanly');
    check(new Set(exhausted.map(t => t.id)).size === exhaustionRequests, 'Exhaustion transfer IDs are not unique');
    const smallAfter = await batch(small.map((w, i) => getWallet(w, smallUsers[i]!)));
    check(smallAfter[0]!.balance_paise === '1' && smallAfter[1]!.balance_paise === '24', 'Exhaustion balances are incorrect');
    const replays = await batch(exhaustBodies.map(body => post(smallUsers[0]!, body)));
    check(replays.every((r, i) => JSON.stringify(r) === JSON.stringify(exhausted[i])), 'Durable exhaustion replays changed their result');
    const smallAfterReplay = await batch(small.map((w, i) => getWallet(w, smallUsers[i]!)));
    check(smallAfterReplay.every((w, i) => w.balance_paise === smallAfter[i]!.balance_paise), 'Exhaustion replays moved money');
    finishPhase('exhaustion');

    return {
      status: 'passed' as const, startedAt, finishedAt: new Date().toISOString(), runId, baseUrl,
      revision: health.revision ?? 'unreported', elapsedMs: Math.round(performance.now() - start), phasesMs: phases,
      concurrentWallet: { requests: walletRequests, uniqueWallets, balance: '10000' },
      idempotency: { requests: replayRequests, uniqueResponses, sourceBalance: sourceAfterRetry.balance_paise, destinationBalance: destinationAfterRetry.balance_paise },
      contention: { requests: contentionRequests, failedRequests: 0, declinedTransfers: results.filter(r => r.status === 'declined').length, totalBefore: totalBefore.toString(), totalAfter: totalAfter.toString(), minimumBalance: minimumBalance.toString(), exactWalletBalances: true },
      exhaustion: { requests: exhaustionRequests, completed, declined, sourceBalance: '1', destinationBalance: '24', identicalReplays: true },
      network: client.report(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Burst verification failed';
    throw Object.assign(new Error(message), { report: { status: 'failed', startedAt, finishedAt: new Date().toISOString(), runId, baseUrl, message, phasesMs: phases, network: client.report() } });
  }
}
export type BurstReport = Awaited<ReturnType<typeof runBurst>>;

async function main() {
  const args = process.argv.slice(2); const baseUrl = args.shift() ?? 'http://localhost:3000';
  const options: BurstOptions = {}; let output: string | undefined;
  const flags = { '--creates': 'walletRequests', '--replays': 'replayRequests', '--transfers': 'contentionRequests', '--exhaustion': 'exhaustionRequests', '--timeout-ms': 'timeoutMs', '--retries': 'maxRetries' } as const;
  while (args.length) {
    const flag = args.shift()!; const value = args.shift();
    if (flag === '--out' && value) output = value;
    else if (flag in flags && value) options[flags[flag as keyof typeof flags]] = Number(value);
    else throw new Error('Usage: npm run burst -- BASE_URL [--creates N --replays N --transfers N --exhaustion N --timeout-ms N --retries N --out FILE]');
  }
  let report: unknown;
  try { report = await runBurst(baseUrl, options); }
  catch (error) {
    report = typeof error === 'object' && error !== null && 'report' in error ? error.report : { status: 'failed', finishedAt: new Date().toISOString(), message: error instanceof Error ? error.message : 'Burst failed' };
    process.exitCode = 1;
  }
  const path = output ?? `docs/evidence/burst-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await mkdir(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(path, serialized);
  process.stdout.write(serialized); process.stderr.write(`Evidence: ${path}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
