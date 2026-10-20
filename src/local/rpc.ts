/**
 * Receipt RPC (design §5).
 *
 * Exactly one `eth_getTransactionReceipt` per confirm request. No
 * subscriptions, no polling, and no `pending` argument anywhere — the caller
 * (longstone) already polls its own broadcasts and drives the retry.
 */

import { parseEventLogs } from 'viem';
import { createPublicClient, http } from 'viem';
import { memoryRegistryAbi } from '@limccn/menhir-core';

import type { ReceiptLike, RpcPort } from '../core/contract.js';

export function createReceiptRpc(rpcUrl: string, registryAddress: `0x${string}`): RpcPort {
  const client = createPublicClient({ transport: http(rpcUrl) });

  return {
    async getTransactionReceipt(txHash: `0x${string}`): Promise<ReceiptLike | null> {
      // No `pending` tag: this is a plain hash lookup and returns null while
      // the transaction is unmined.
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      if (receipt === null) return null;

      // Only logs emitted BY THE REGISTRY count. Any contract can emit an event
      // with this signature, so without the address filter a forged
      // MemoryCommitted could flip a batched row to anchored (review M4).
      const registryLogs = receipt.logs.filter(
        (log) => log.address.toLowerCase() === registryAddress.toLowerCase(),
      );

      // Decode through @limccn/menhir-core's generated ABI rather than a local event
      // fragment, so a contract event change breaks the import, not the decode.
      const logs = parseEventLogs({
        abi: memoryRegistryAbi,
        logs: registryLogs,
        eventName: 'MemoryCommitted',
      });

      return {
        status: receipt.status === 'success' ? 'success' : 'reverted',
        commits: logs.map((log) => ({
          owner: log.args.owner as `0x${string}`,
          contentHash: log.args.contentHash as `0x${string}`,
        })),
      };
    },
  };
}
