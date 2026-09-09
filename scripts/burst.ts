import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

interface WalletResponse {
  id: string;
  balance_paise: string;
}

interface TransferResponse {
  id: string;
  status: 'completed' | 'declined';
}

export interface BurstReport {
  concurrentWallet: { requests: number; uniqueWallets: number };
  idempotency: {
    requests: number;
    uniqueResponses: number;
    sourceBalance: string;
    destinationBalance: string;
  };
  contention: {
    requests: number;
    failedRequests: number;
    declinedTransfers: number;
    totalBefore: string;
    totalAfter: string;
    minimumBalance: bigint;
  };
}

async function requestJson<T>(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  user?: string,
  body?: unknown,
): Promise<T> {
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(user ? { authorization: `Bearer ${user}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'x-correlation-id': `burst-${randomUUID()}`,
        },
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
      });
      const payload = (await response.json()) as T & { code?: string; message?: string };
      if (!response.ok) {
        throw new Error(
          `${method} ${path} returned ${response.status}: ${payload.code ?? payload.message ?? 'unknown error'}`,
        );
      }
      return payload;
    } catch (error) {
      const transportFailure = error instanceof TypeError && error.message === 'fetch failed';
      if (!transportFailure || attempt === 3) throw error;
    }
  }
  throw new Error(`${method} ${path} exhausted transport retries`);
}

function total(wallets: WalletResponse[]): bigint {
  return wallets.reduce((sum, wallet) => sum + BigInt(wallet.balance_paise), 0n);
}

export async function runBurst(rawBaseUrl: string): Promise<BurstReport> {
  const baseUrl = rawBaseUrl.replace(/\/$/, '');
  const runId = randomUUID();

  const concurrentUser = `probe-wallet-${runId}`;
  const concurrentResponses = await Promise.all(
    Array.from({ length: 50 }, () =>
      requestJson<WalletResponse>(baseUrl, 'POST', '/wallets', concurrentUser, { initial_balance_paise: 10_000 }),
    ),
  );
  const uniqueWallets = new Set(concurrentResponses.map((wallet) => wallet.id)).size;
  if (uniqueWallets !== 1) throw new Error(`Concurrent get-or-create produced ${uniqueWallets} wallets`);

  const users = ['alice', 'bob', 'carol'].map((name) => `${name}-${runId}`);
  const wallets = await Promise.all(
    users.map((user) =>
      requestJson<WalletResponse>(baseUrl, 'POST', '/wallets', user, { initial_balance_paise: 10_000 }),
    ),
  );
  const [alice, bob] = wallets;
  if (!alice || !bob) throw new Error('Probe wallet creation returned an incomplete result');

  const idempotentCommand = {
    from: alice.id,
    to: bob.id,
    amount_paise: 1_000,
    idempotency_key: `retry-${runId}`,
  };
  const retryResponses = await Promise.all(
    Array.from({ length: 30 }, () =>
      requestJson<TransferResponse>(baseUrl, 'POST', '/transfers', users[0], idempotentCommand),
    ),
  );
  const uniqueResponses = new Set(retryResponses.map((transfer) => JSON.stringify(transfer))).size;
  if (uniqueResponses !== 1) throw new Error(`Idempotency storm returned ${uniqueResponses} different responses`);

  const sourceAfterRetry = await requestJson<WalletResponse>(baseUrl, 'GET', `/wallets/${alice.id}`, users[0]);
  const destinationAfterRetry = await requestJson<WalletResponse>(baseUrl, 'GET', `/wallets/${bob.id}`, users[1]);
  if (sourceAfterRetry.balance_paise !== '9000' || destinationAfterRetry.balance_paise !== '11000') {
    throw new Error('Idempotency storm changed balances more than once');
  }

  const before = await Promise.all(
    wallets.map((wallet, index) => requestJson<WalletResponse>(baseUrl, 'GET', `/wallets/${wallet.id}`, users[index])),
  );
  const totalBefore = total(before);
  const contentionCommands = Array.from({ length: 180 }, (_, index) => {
    const sourceIndex = index % wallets.length;
    const destinationIndex = (sourceIndex + 1 + (index % 2)) % wallets.length;
    return {
      user: users[sourceIndex]!,
      body: {
        from: wallets[sourceIndex]!.id,
        to: wallets[destinationIndex]!.id,
        amount_paise: index % 9 === 0 ? 50_000 : 3,
        idempotency_key: `contention-${runId}-${index}`,
      },
    };
  });

  const results = await Promise.allSettled(
    contentionCommands.map(({ user, body }) =>
      requestJson<TransferResponse>(baseUrl, 'POST', '/transfers', user, body),
    ),
  );
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  const failedRequests = failures.length;
  if (failedRequests > 0) {
    const examples = failures
      .slice(0, 3)
      .map((failure) => {
        if (!(failure.reason instanceof Error)) return String(failure.reason);
        const cause = 'cause' in failure.reason ? String(failure.reason.cause) : '';
        return cause ? `${failure.reason.message} (${cause})` : failure.reason.message;
      })
      .join('; ');
    throw new Error(`${failedRequests} contention requests failed at the HTTP layer: ${examples}`);
  }
  const declinedTransfers = results.filter(
    (result) => result.status === 'fulfilled' && result.value.status === 'declined',
  ).length;

  const after = await Promise.all(
    wallets.map((wallet, index) => requestJson<WalletResponse>(baseUrl, 'GET', `/wallets/${wallet.id}`, users[index])),
  );
  const totalAfter = total(after);
  const minimumBalance = after.reduce(
    (minimum, wallet) => (BigInt(wallet.balance_paise) < minimum ? BigInt(wallet.balance_paise) : minimum),
    BigInt(after[0]?.balance_paise ?? 0),
  );
  if (totalAfter !== totalBefore) throw new Error(`Conservation failed: ${totalBefore} became ${totalAfter}`);
  if (minimumBalance < 0n) throw new Error(`A wallet became negative: ${minimumBalance}`);

  return {
    concurrentWallet: { requests: concurrentResponses.length, uniqueWallets },
    idempotency: {
      requests: retryResponses.length,
      uniqueResponses,
      sourceBalance: sourceAfterRetry.balance_paise,
      destinationBalance: destinationAfterRetry.balance_paise,
    },
    contention: {
      requests: contentionCommands.length,
      failedRequests,
      declinedTransfers,
      totalBefore: totalBefore.toString(),
      totalAfter: totalAfter.toString(),
      minimumBalance,
    },
  };
}

async function main(): Promise<void> {
  const baseUrl = process.argv[2] ?? 'http://localhost:3000';
  const report = await runBurst(baseUrl);
  process.stdout.write(
    `${JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
