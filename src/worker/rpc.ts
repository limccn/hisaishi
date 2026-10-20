/**
 * Receipt RPC for F2.
 *
 * Identical contract to F1: exactly one `eth_getTransactionReceipt`, decoded
 * through `@menhir/core`'s ABI, no `pending` tag, no polling.
 *
 * Built on `fetch` rather than viem's client so it runs unchanged under
 * workerd without pulling a Node transport.
 */

import { decodeEventLog } from 'viem';
import { memoryRegistryAbi } from '@menhir/core';

import type { ReceiptLike, RpcPort } from '../core/contract.js';

interface JsonRpcResponse<T> {
  result?: T;
  error?: { message: string };
}

interface RawReceipt {
  status: `0x${string}`;
  logs: Array<{ address: `0x${string}`; data: `0x${string}`; topics: `0x${string}`[] }>;
}

export function createReceiptRpc(rpcUrl: string, registryAddress: `0x${string}`): RpcPort {
  return {
    async getTransactionReceipt(txHash: `0x${string}`): Promise<ReceiptLike | null> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getTransactionReceipt',
            // A hash lookup, not a block tag: there is no `pending` here.
            params: [txHash],
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) throw new Error(`rpc returned ${response.status}`);
      const body = (await response.json()) as JsonRpcResponse<RawReceipt | null>;
      if (body.error !== undefined) throw new Error(body.error.message);
      if (body.result === null || body.result === undefined) return null;

      const commits: ReceiptLike['commits'] = [];
      for (const log of body.result.logs) {
        // Address filter: any contract can emit this event signature, so a
        // forged MemoryCommitted must not flip a batched row (review M4).
        if (log.address.toLowerCase() !== registryAddress.toLowerCase()) {
          continue;
        }
        try {
          const decoded = decodeEventLog({
            abi: memoryRegistryAbi,
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          if (decoded.eventName === 'MemoryCommitted') {
            const args = decoded.args as unknown as {
              owner: `0x${string}`;
              contentHash: `0x${string}`;
            };
            commits.push({ owner: args.owner, contentHash: args.contentHash });
          }
        } catch {
          // A log from another contract in the same tx is expected; ignore it.
        }
      }

      return {
        status: body.result.status === '0x1' ? 'success' : 'reverted',
        commits,
      };
    },
  };
}
