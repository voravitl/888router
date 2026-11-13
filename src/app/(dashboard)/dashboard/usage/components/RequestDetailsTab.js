"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

let providerNameCache = null;
let providerNodesCache = null;

async function fetchProviderNames() {
  if (providerNameCache && providerNodesCache) {
    return { providerNameCache, providerNodesCache };
  }

  const nodesRes = await fetch("/api/provider-nodes");
  const nodesData = await nodesRes.json();
  const nodes = nodesData.nodes || [];
  providerNodesCache = {};

  for (const node of nodes) {
    providerNodesCache[node.id] = node.name;
  }

  providerNameCache = {
    ...AI_PROVIDERS,
    ...providerNodesCache
  };

  return { providerNameCache, providerNodesCache };
}

function getProviderName(providerId, cache) {
  if (!providerId) return providerId;
  if (!cache) return providerId;

  const cached = cache[providerId];

  if (typeof cached === 'string') {
    return cached;
  }

  if (cached?.name) {
    return cached.name;
  }

  const providerConfig = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
  return providerConfig?.name || providerId;
}

function CollapsibleSection({ title, children, defaultOpen = false, icon = null }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  
  return (
    <div className="border border-black/5 dark:border-white/5 rounded-lg overflow-hidden">
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon && <span className="material-symbols-outlined text-[18px] text-text-muted">{icon}</span>}
          <span className="font-semibold text-sm text-text-main">{title}</span>
        </div>
        <span className={cn(
          "material-symbols-outlined text-[20px] text-text-muted transition-transform duration-200",
          isOpen ? "rotate-90" : ""
        )}>
          chevron_right
        </span>
      </button>
      
      {isOpen && (
        <div className="p-4 border-t border-black/5 dark:border-white/5">
          {children}
        </div>
      )}
    </div>
  );
}

function getCachedTokens(tokens) {
  return tokens?.cached_tokens || tokens?.cache_read_input_tokens || 0;
}

function getCacheCreationTokens(tokens) {
  return tokens?.cache_creation_input_tokens || 0;
}

function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  // Canonical storage keeps prompt cache-inclusive. Legacy Claude rows may have
  // stored prompt cache-exclusive; fall back to cache when it's larger so old
  // rows don't under-report input.
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}

function formatTokenSaveCell(detail) {
  const parts = [];
  const rtk = detail?.rtkStats;
  if (rtk && typeof rtk.bytesBefore === "number" && typeof rtk.bytesAfter === "number" && rtk.bytesBefore > 0) {
    const saved = rtk.bytesBefore - rtk.bytesAfter;
    const pct = Math.round((saved / rtk.bytesBefore) * 100);
    parts.push(`RTK −${saved}B (${pct}%)`);
  }
  const hs = detail?.headroomStats;
  if (hs && typeof hs.savedTokens === "number" && hs.savedTokens > 0) {
    parts.push(`HR −${hs.savedTokens}tok`);
  } else {
    const d = detail?.headroomDiagnostics || {};
    const before = d.beforeBytes ?? d.bytesBefore;
    const after = d.afterBytes ?? d.bytesAfter;
    if (typeof before === "number" && typeof after === "number" && before > after) {
      parts.push(`HR −${before - after}B`);
    }
  }
  return parts.length ? parts.join(" · ") : "—";
}

export default function RequestDetailsTab() {
  const [details, setDetails] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 0
  });
  const [loading, setLoading] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [providers, setProviders] = useState([]);
  const [providerNameCache, setProviderNameCache] = useState(null);
  const [filters, setFilters] = useState({
    provider: "",
    startDate: "",
    endDate: ""
  });

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/usage/providers");
      const data = await res.json();
      setProviders(data.providers || []);

      const cache = await fetchProviderNames();
      setProviderNameCache(cache.providerNameCache);
    } catch (error) {
      console.error("Failed to fetch providers:", error);
    }
  }, []);

  const fetchDetails = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString()
      });
      if (filters.provider) params.append("provider", filters.provider);
      if (filters.startDate) params.append("startDate", filters.startDate);
      if (filters.endDate) params.append("endDate", filters.endDate);

      const res = await fetch(`/api/usage/request-details?${params}`);
      const data = await res.json();

      setDetails(data.details || []);
      setPagination(prev => ({ ...prev, ...data.pagination }));
    } catch (error) {
      console.error("Failed to fetch request details:", error);
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, filters]);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  const handleViewDetail = (detail) => {
    setSelectedDetail(detail);
    setIsDrawerOpen(true);
  };

  const handlePageChange = (newPage) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const handlePageSizeChange = (newPageSize) => {
    setPagination(prev => ({ ...prev, pageSize: newPageSize, page: 1 }));
  };

  const handleClearFilters = () => {
    setFilters({ provider: "", startDate: "", endDate: "" });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="provider-filter" className="text-sm font-medium text-text-main">Provider</label>
            <select
              id="provider-filter"
              value={filters.provider}
              onChange={(e) => setFilters({ ...filters, provider: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20",
                "w-full min-w-0 cursor-pointer"
              )}
              style={{ colorScheme: 'auto' }}
            >
              <option value="">All Providers</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>
          
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="start-date-filter" className="text-sm font-medium text-text-main">Start Date</label>
            <input
              id="start-date-filter"
              type="datetime-local"
              value={filters.startDate}
              onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
              )}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="end-date-filter" className="text-sm font-medium text-text-main">End Date</label>
            <input
              id="end-date-filter"
              type="datetime-local"
              value={filters.endDate}
              onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
              )}
            />
          </div>
          
          <div className="flex min-w-0 flex-col gap-2 sm:col-span-2 lg:col-span-1">
            <span className="hidden text-sm font-medium text-text-main opacity-0 lg:block" aria-hidden="true">Clear</span>
            <Button 
              variant="ghost" 
              onClick={handleClearFilters}
              disabled={!filters.provider && !filters.startDate && !filters.endDate}
              className="w-full"
            >
              Clear Filters
            </Button>
          </div>
        </div>
      </Card>

      <div className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-xs tabular-nums">
            <thead>
              <tr className="border-b border-border bg-bg-alt text-[11px] font-medium text-text-muted">
                <th className="text-left px-4 py-2.5">Timestamp</th>
                <th className="text-left px-4 py-2.5">Model</th>
                <th className="text-left px-4 py-2.5">Provider</th>
                <th className="text-right px-4 py-2.5">Input</th>
                <th className="text-right px-4 py-2.5">Cached</th>
                <th className="text-right px-4 py-2.5">Write</th>
                <th className="text-right px-4 py-2.5">Output</th>
                <th className="text-left px-4 py-2.5">Token Save</th>
                <th className="text-left px-4 py-2.5">Span (TTFT / Total)</th>
                <th className="text-center px-4 py-2.5">Trace</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {loading ? (
                <tr>
                  <td colSpan="10" className="p-8 text-center text-text-muted">
                    Loading request traces...
                  </td>
                </tr>
              ) : details.length === 0 ? (
                <tr>
                  <td colSpan="10" className="p-8 text-center text-text-muted">
                    No request details found.
                  </td>
                </tr>
              ) : (
                details.map((detail, index) => {
                  const ttft = Number(detail.latency?.ttft || 0);
                  const total = Number(detail.latency?.total || 0);
                  const ttftPct = total > 0 ? Math.min(100, Math.round((ttft / total) * 100)) : 0;
                  return (
                    <tr
                      key={`${detail.id}-${index}`}
                      onClick={() => handleViewDetail(detail)}
                      className="cursor-pointer hover:bg-surface-2/60 transition-colors"
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-text-muted">
                        {new Date(detail.timestamp).toLocaleString()}
                      </td>
                      <td className="max-w-[240px] truncate px-4 py-2.5 font-medium text-text-main">
                        {detail.model}
                      </td>
                      <td className="max-w-[160px] truncate px-4 py-2.5 text-text-muted">
                        {getProviderName(detail.provider, providerNameCache)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-text-main">
                        {getInputTokens(detail.tokens).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-emerald-600 dark:text-emerald-400">
                        {getCachedTokens(detail.tokens) > 0 ? getCachedTokens(detail.tokens).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-text-muted">
                        {getCacheCreationTokens(detail.tokens) > 0 ? getCacheCreationTokens(detail.tokens).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-text-main">
                        {detail.tokens?.completion_tokens?.toLocaleString() || 0}
                      </td>
                      <td className="max-w-[160px] truncate px-4 py-2.5 text-text-muted" title={formatTokenSaveCell(detail)}>
                        {formatTokenSaveCell(detail)}
                      </td>
                      <td className="px-4 py-2.5 min-w-[140px]">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-between font-mono text-[10px] text-text-muted">
                            <span>{ttft}ms</span>
                            <span className="text-text-main font-semibold">{total}ms</span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-surface-2 flex overflow-hidden">
                            <span className="h-full bg-[#111111] dark:bg-[#fafafa]" style={{ width: `${ttftPct}%` }} />
                            <span className="h-full bg-[#a6c23f] flex-1" />
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleViewDetail(detail);
                          }}
                        >
                          Inspect
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && details.length > 0 && (
          <div className="border-t border-border bg-bg-alt">
            <Pagination
              currentPage={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.totalItems}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          </div>
        )}
      </div>

      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        title={`Trace: ${selectedDetail?.model || "Request Detail"}`}
        width="lg"
      >
        {selectedDetail && (() => {
          const ttftMs = Math.max(0, Number(selectedDetail.latency?.ttft || 0));
          const totalMs = Math.max(ttftMs, Number(selectedDetail.latency?.total || 0));
          const streamMs = Math.max(0, totalMs - ttftMs);
          const ttftPct = totalMs > 0 ? Math.min(100, Math.round((ttftMs / totalMs) * 100)) : 50;
          const streamPct = Math.max(0, 100 - ttftPct);
          return (
          <div className="space-y-5 text-xs tabular-nums">
            {/* Scaled ms Waterfall Span Timeline */}
            <div className="rounded-xl border border-border bg-bg-alt p-3.5 space-y-2.5">
              <div className="flex items-center justify-between text-[11px] font-medium text-text-muted">
                <span>Execution Waterfall</span>
                <span className="font-mono text-text-main font-semibold">Total {totalMs}ms</span>
              </div>

              <div className="space-y-2">
                <div className="grid grid-cols-12 items-center gap-2">
                  <span className="col-span-4 text-[11px] text-text-muted truncate">1. Prefill / TTFT</span>
                  <div className="col-span-6 h-3 rounded bg-surface border border-border-subtle flex overflow-hidden">
                    <span className="h-full bg-[#111111] dark:bg-[#fafafa]" style={{ width: `${Math.max(4, ttftPct)}%` }} />
                  </div>
                  <span className="col-span-2 text-right font-mono text-text-main">{ttftMs}ms</span>
                </div>

                <div className="grid grid-cols-12 items-center gap-2">
                  <span className="col-span-4 text-[11px] text-text-muted truncate">2. Decode Stream</span>
                  <div className="col-span-6 h-3 rounded bg-surface border border-border-subtle relative flex overflow-hidden">
                    <span style={{ width: `${ttftPct}%` }} />
                    <span className="h-full bg-[#a6c23f]" style={{ width: `${Math.max(4, streamPct)}%` }} />
                  </div>
                  <span className="col-span-2 text-right font-mono text-text-main">{streamMs}ms</span>
                </div>
              </div>
            </div>

            {/* Metadata Spec Grid */}
            <div className="rounded-xl border border-border divide-y divide-border-subtle overflow-hidden">
              <div className="flex justify-between gap-3 px-3.5 py-2.5">
                <span className="text-text-muted">Trace ID</span>
                <span className="font-mono break-all text-text-main text-right">{selectedDetail.id}</span>
              </div>
              <div className="flex justify-between gap-3 px-3.5 py-2.5">
                <span className="text-text-muted">Timestamp</span>
                <span className="font-mono text-text-main">{new Date(selectedDetail.timestamp).toLocaleString()}</span>
              </div>
              <div className="flex justify-between gap-3 px-3.5 py-2.5">
                <span className="text-text-muted">Provider</span>
                <span className="text-text-main font-medium">
                  {getProviderName(selectedDetail.provider, providerNameCache)}
                </span>
              </div>
              <div className="flex justify-between gap-3 px-3.5 py-2.5">
                <span className="text-text-muted">Upstream Model</span>
                <span className="font-mono text-text-main font-semibold">{selectedDetail.model}</span>
              </div>
              {selectedDetail.clientModel && selectedDetail.clientModel !== selectedDetail.model ? (
                <div className="flex justify-between gap-3 px-3.5 py-2.5">
                  <span className="text-text-muted">Client Alias</span>
                  <span className="font-mono text-text-main">{selectedDetail.clientModel}</span>
                </div>
              ) : null}
              <div className="flex justify-between gap-3 px-3.5 py-2.5">
                <span className="text-text-muted">Status</span>
                <span className={cn("font-semibold uppercase", selectedDetail.status === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-[#dc2626]")}>
                  {selectedDetail.status}
                </span>
              </div>
              <div className="flex justify-between gap-3 px-3.5 py-2.5">
                <span className="text-text-muted">Tokens (In / Cache / Write / Out)</span>
                <span className="font-mono text-text-main">
                  {getInputTokens(selectedDetail.tokens).toLocaleString()} / {getCachedTokens(selectedDetail.tokens).toLocaleString()} / {getCacheCreationTokens(selectedDetail.tokens).toLocaleString()} / {(selectedDetail.tokens?.completion_tokens || 0).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between gap-3 px-3.5 py-2.5">
                <span className="text-text-muted">Token Save (RTK / Headroom)</span>
                <span className="font-mono text-text-main">{formatTokenSaveCell(selectedDetail)}</span>
              </div>
            </div>

            {(selectedDetail.rtkStats || selectedDetail.headroomStats || selectedDetail.headroomDiagnostics) ? (
              <CollapsibleSection title="Token save benchmark (RTK / Headroom)" defaultOpen={true} icon="savings">
                <div className="grid min-w-0 grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                  {selectedDetail.rtkStats ? (
                    <div>
                      <p className="mb-1 text-[11px] font-medium text-text-muted">RTK</p>
                      <pre className="max-h-[200px] overflow-auto rounded-lg border border-border bg-bg-alt p-3 font-mono text-xs">
                        {JSON.stringify(selectedDetail.rtkStats, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  {selectedDetail.headroomStats ? (
                    <div>
                      <p className="mb-1 text-[11px] font-medium text-text-muted">Headroom stats</p>
                      <pre className="max-h-[200px] overflow-auto rounded-lg border border-border bg-bg-alt p-3 font-mono text-xs">
                        {JSON.stringify(selectedDetail.headroomStats, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  {selectedDetail.headroomDiagnostics ? (
                    <div className="sm:col-span-2">
                      <p className="mb-1 text-[11px] font-medium text-text-muted">Headroom diagnostics</p>
                      <pre className="max-h-[200px] overflow-auto rounded-lg border border-border bg-bg-alt p-3 font-mono text-xs">
                        {JSON.stringify(selectedDetail.headroomDiagnostics, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              </CollapsibleSection>
            ) : null}

            <div className="space-y-3">
              <CollapsibleSection title="1. Client Request (Input)" defaultOpen={true} icon="input">
                <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-border bg-bg-alt p-3 font-mono text-xs text-text-main">
                  {JSON.stringify(selectedDetail.request, null, 2)}
                </pre>
              </CollapsibleSection>

              {selectedDetail.providerRequest && (
                <CollapsibleSection title="2. Provider Request (Translated)" icon="translate">
                  <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-border bg-bg-alt p-3 font-mono text-xs text-text-main">
                    {JSON.stringify(selectedDetail.providerRequest, null, 2)}
                  </pre>
                </CollapsibleSection>
              )}

              {selectedDetail.providerResponse && (
                <CollapsibleSection title="3. Provider Response (Raw)" icon="data_object">
                  <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-border bg-bg-alt p-3 font-mono text-xs text-text-main">
                    {typeof selectedDetail.providerResponse === "object"
                      ? JSON.stringify(selectedDetail.providerResponse, null, 2)
                      : selectedDetail.providerResponse}
                  </pre>
                </CollapsibleSection>
              )}

              <CollapsibleSection title="4. Client Response (Final)" defaultOpen={true} icon="output">
                {selectedDetail.response?.thinking && (
                  <div className="mb-4">
                    <h4 className="font-semibold text-text-muted mb-2 flex items-center gap-2 text-[11px]">
                      <span className="material-symbols-outlined text-[15px]">psychology</span>
                      Thinking Process
                    </h4>
                    <pre className="max-h-[200px] max-w-full overflow-auto rounded-lg border border-border bg-bg-alt p-3 font-mono text-xs text-text-main">
                      {selectedDetail.response.thinking}
                    </pre>
                  </div>
                )}

                <h4 className="font-semibold text-text-muted mb-2 text-[11px]">
                  Content
                </h4>
                <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-border bg-bg-alt p-3 font-mono text-xs text-text-main">
                  {selectedDetail.response?.content || "[No content]"}
                </pre>
              </CollapsibleSection>
            </div>
          </div>
          );
        })()}
      </Drawer>
    </div>
  );
}
