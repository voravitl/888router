/**
 * In-memory HealthStore for tracking node and provider circuit breaker state.
 * Implements Layered Health Signaling (L1 Account Lock -> L2 Node CB -> L3 Provider CB).
 */

class MemoryHealthStore {
  constructor() {
    this.nodeFailures = new Map(); // nodeId -> { count: number, resetAt: number }
    this.providerFailedNodes = new Map(); // providerId -> Set<nodeId>
    this.cooldownMs = 60000;
    this.maxNodeErrors = 3;
    this.minFailedNodesForProviderCB = 3;
  }

  now() {
    return Date.now();
  }

  recordSuccess(providerId, nodeId) {
    if (nodeId) {
      this.nodeFailures.delete(nodeId);
      if (providerId && this.providerFailedNodes.has(providerId)) {
        this.providerFailedNodes.get(providerId).delete(nodeId);
      }
    }
  }

  recordError(providerId, nodeId, statusCode) {
    // 429 quota error on a single account is NOT a node/provider death — do not record as node error
    if (statusCode === 429) return;

    if (nodeId) {
      const entry = this.nodeFailures.get(nodeId) || { count: 0, resetAt: this.now() + this.cooldownMs };
      if (this.now() > entry.resetAt) {
        entry.count = 0;
        entry.resetAt = this.now() + this.cooldownMs;
      }
      entry.count += 1;
      this.nodeFailures.set(nodeId, entry);

      if (entry.count >= this.maxNodeErrors && providerId) {
        if (!this.providerFailedNodes.has(providerId)) {
          this.providerFailedNodes.set(providerId, new Set());
        }
        this.providerFailedNodes.get(providerId).add(nodeId);
      }
    }
  }

  isNodeOpen(nodeId) {
    if (!nodeId) return false;
    const entry = this.nodeFailures.get(nodeId);
    if (!entry) return false;
    if (this.now() > entry.resetAt) {
      this.nodeFailures.delete(nodeId);
      return false;
    }
    return entry.count >= this.maxNodeErrors;
  }

  isProviderOpen(providerId) {
    if (!providerId) return false;
    const failedSet = this.providerFailedNodes.get(providerId);
    if (!failedSet) return false;
    return failedSet.size >= this.minFailedNodesForProviderCB;
  }

  clear() {
    this.nodeFailures.clear();
    this.providerFailedNodes.clear();
  }
}

export const healthStore = new MemoryHealthStore();
