"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Button,
  Input,
  Modal,
  Pagination,
  Segmented,
  Select,
  Switch,
  Table,
  Tag,
  Tooltip as AntTooltip,
} from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DashboardOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  HourglassOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaTable from "./QuotaTable";
import {
  parseQuotaData,
  calculatePercentage,
  getConnectionLabel,
  getRemainingPercentage,
  sortVisibleConnections,
  buildLoadingState,
  filterQuotaStateByConnections,
  getConnectionsEmptyMessage,
  getPageSizeLabel,
  getConnectionsPaginationSummary,
  getSafePagination,
  getSafeTotals,
  shouldResetPage,
  getPaginationPageValue,
  getProviderOptions,
  reconcileConnectionsPage,
  getQuotaCache,
  QUOTA_CACHE_KEY,
  setQuotaCache,
  formatResetTime,
  REFRESH_INTERVAL_MS,
  CLAUDE_REFRESH_INTERVAL_MS,
  DEPLETED_QUOTA_THRESHOLD,
  AUTO_REFRESH_STORAGE_KEY,
  CONNECTIONS_PAGE_SIZE,
  ACCOUNT_PAGE_SIZE_OPTIONS,
  ACCOUNT_PAGE_SIZE_MAX,
  ACCOUNT_FILTER_OPTIONS,
  QUOTA_SORT_OPTIONS,
} from "./utils";
import {
  findEarliestResetMs,
  formatResetTimeDisplay,
  getQuotaTone,
  pickPrimaryQuota,
} from "./quotaVisuals";
import Card from "@/shared/components/Card";
import { ConfirmModal, EditConnectionModal, PageHero } from "@/shared/components";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const KIRO_METHOD_LABELS = {
  "builder-id": "AWS Builder ID",
  idc: "IAM Identity Center",
  google: "Google",
  github: "GitHub",
  imported: "Imported Token",
  api_key: "API Key",
};

const AUTO_PING_SETTINGS_KEYS = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

const AUTO_PING_TOOLTIPS = {
  claude: "Auto-sends a request when the 5h window resets so the next window starts immediately.",
  codex: "Auto-starts the next 5h Codex window after reset with a tiny gpt-5.5 request.",
};

function kiroMethodLabel(conn) {
  const m = conn.providerSpecificData?.authMethod;
  if (m && KIRO_METHOD_LABELS[m]) return KIRO_METHOD_LABELS[m];
  return conn.authType === "api_key" ? "API Key" : "OAuth";
}

function getConnectionSecondaryLabel(connection) {
  if (connection.name?.trim() && connection.email?.trim() && connection.name.trim() !== connection.email.trim()) {
    return connection.email.trim();
  }
  if (connection.name?.trim() && connection.displayName?.trim() && connection.name.trim() !== connection.displayName.trim()) {
    return connection.displayName.trim();
  }
  return null;
}

function kiroRegion(conn) {
  const r = conn.providerSpecificData?.region;
  if (r) return r;
  const arn = conn.providerSpecificData?.profileArn;
  const seg = typeof arn === "string" ? arn.split(":")[3] : "";
  return seg || "";
}

function getCodexResetCreditCount(quota) {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function formatCreditDate(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "N/A";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeRemaining(value) {
  if (!value) return "N/A";
  const diffMs = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return "N/A";
  if (diffMs <= 0) return "Expired";
  const totalHours = Math.ceil(diffMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

function ConnectionIdentity({ conn, copied, onCopy }) {
  const isInactive = conn.isActive === false;
  const secondary = getConnectionSecondaryLabel(conn);
  const statusOk = conn.testStatus === "active" || conn.testStatus === "success";
  const statusBad = conn.testStatus === "error" || conn.testStatus === "expired" || conn.testStatus === "unavailable";

  return (
    <div className="flex items-start gap-2.5 min-w-0">
      <div className="size-8 shrink-0 rounded-lg border border-border-subtle bg-bg-alt flex items-center justify-center overflow-hidden p-1">
        <ProviderIcon
          src={`/providers/${conn.provider}.png`}
          alt={conn.provider}
          size={24}
          className="object-contain"
          fallbackText={conn.provider?.slice(0, 2).toUpperCase() || "PR"}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-text-main capitalize">
            {conn.provider}
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.2 text-[10px] font-medium border ${
              isInactive
                ? "border-border bg-bg-alt text-text-muted"
                : statusOk
                  ? "border-[#a6c23f]/35 bg-[#a6c23f]/10 text-[#5f7813] dark:text-[#b7d354]"
                  : statusBad
                    ? "border-red-500/35 bg-red-500/10 text-red-600 dark:text-red-400"
                    : "border-border bg-bg-alt text-text-muted"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${
                isInactive ? "bg-text-subtle" : statusOk ? "bg-[#a6c23f]" : statusBad ? "bg-red-500" : "bg-text-subtle"
              }`}
            />
            {isInactive ? "disabled" : conn.testStatus || "ready"}
          </span>
        </div>

        {getConnectionLabel(conn) && (
          <div className="text-xs text-text-main font-medium truncate mt-0.5">
            {getConnectionLabel(conn)}
          </div>
        )}
        {secondary && (
          <div className="text-[11px] text-text-muted truncate">{secondary}</div>
        )}

        {conn.provider === "kiro" && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Tag className="m-0 text-[10px]">{kiroMethodLabel(conn)}</Tag>
            {kiroRegion(conn) && <Tag className="m-0 text-[10px] font-mono">{kiroRegion(conn)}</Tag>}
            {conn.providerSpecificData?.profileArn && (
              <button
                type="button"
                onClick={() => onCopy(conn.providerSpecificData.profileArn, conn.id)}
                title={conn.providerSpecificData.profileArn}
                className="inline-flex max-w-[180px] items-center gap-1 rounded border border-border bg-bg-alt px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-main cursor-pointer"
              >
                <CopyOutlined className="text-[10px] shrink-0" />
                <code className="truncate font-mono">
                  {copied === conn.id ? "Copied" : conn.providerSpecificData.profileArn}
                </code>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectionActions({
  conn,
  quota,
  isLoading,
  rowBusy,
  isResettingLimit,
  deletingId,
  autoPingEnabled,
  onResetConfirm,
  onViewResetCredits,
  onToggleAutoPing,
  onRefresh,
  onEdit,
  onDelete,
  onToggleActive,
}) {
  const isCodex = conn.provider === "codex";
  const resetCreditCount = getCodexResetCreditCount(quota);
  const supportsAutoPing = Boolean(AUTO_PING_SETTINGS_KEYS[conn.provider]) && conn.authType === "oauth";

  return (
    <div className="flex items-center justify-end gap-1 shrink-0">
      {isCodex && (
        <>
          <AntTooltip
            title={
              resetCreditCount > 0
                ? `Use 1 Codex reset credit (${resetCreditCount} available)`
                : "No Codex reset credits available"
            }
          >
            <Button
              size="small"
              disabled={resetCreditCount <= 0 || isLoading || rowBusy}
              loading={isResettingLimit}
              onClick={() => onResetConfirm(conn, resetCreditCount)}
              icon={<ReloadOutlined />}
              className="font-mono text-[11px]"
            >
              {resetCreditCount}
            </Button>
          </AntTooltip>
          <AntTooltip title="View Codex reset credit expiry">
            <Button
              size="small"
              icon={<ClockCircleOutlined />}
              disabled={isLoading || rowBusy}
              onClick={() => onViewResetCredits(conn)}
              aria-label="View Codex reset credit expiry"
            />
          </AntTooltip>
        </>
      )}

      {supportsAutoPing && (
        <AntTooltip title={AUTO_PING_TOOLTIPS[conn.provider]}>
          <Button
            size="small"
            type={autoPingEnabled ? "primary" : "default"}
            icon={<ThunderboltOutlined />}
            onClick={() => onToggleAutoPing(conn.id, conn.provider, !autoPingEnabled)}
            aria-label="Toggle auto-ping"
          />
        </AntTooltip>
      )}

      <AntTooltip title="Refresh quota">
        <Button
          size="small"
          icon={<ReloadOutlined spin={Boolean(isLoading)} />}
          disabled={isLoading || rowBusy}
          onClick={() => onRefresh(conn.id, conn.provider)}
          aria-label="Refresh quota"
        />
      </AntTooltip>

      <AntTooltip title="Edit connection">
        <Button
          size="small"
          icon={<EditOutlined />}
          disabled={rowBusy}
          onClick={() => onEdit(conn)}
          aria-label="Edit connection"
        />
      </AntTooltip>

      <AntTooltip title="Delete connection">
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          loading={deletingId === conn.id}
          disabled={rowBusy}
          onClick={() => onDelete(conn)}
          aria-label="Delete connection"
        />
      </AntTooltip>

      <AntTooltip title={(conn.isActive ?? true) ? "Disable connection" : "Enable connection"}>
        <span className="inline-flex pl-1">
          <Switch
            size="small"
            checked={conn.isActive ?? true}
            disabled={rowBusy}
            onChange={(nextActive) => onToggleActive(conn.id, nextActive)}
          />
        </span>
      </AntTooltip>
    </div>
  );
}

export default function ProviderLimits() {
  const { copied, copy } = useCopyToClipboard();
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoPingMaps, setAutoPingMaps] = useState({ claude: {}, codex: {} });
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteConfirmConn, setDeleteConfirmConn] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [resetCreditsState, setResetCreditsState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [providerFilter, setProviderFilter] = useState("all");
  const [providerOptions, setProviderOptions] = useState([]);
  const [accountFilter, setAccountFilter] = useState("all");
  const [quotaSortMode, setQuotaSortMode] = useState("default");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState("matrix");
  const [bulkToggling, setBulkToggling] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const [customPageMode, setCustomPageMode] = useState(false);
  const [customPageSizeInput, setCustomPageSizeInput] = useState(String(CONNECTIONS_PAGE_SIZE));
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: CONNECTIONS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
  });

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);
  const tickCountRef = useRef(0);

  const fetchConnections = useCallback(
    async (targetPage = page) => {
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: accountFilter,
          sort: "priority",
        });

        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }

        const response = await fetch(`/api/providers/client?${params.toString()}`);
        if (!response.ok) throw new Error("Failed to fetch connections");

        const data = await response.json();
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);

        setConnections(connectionList);
        setProviderOptions(getProviderOptions(data.providerOptions));
        setPagination(nextPagination);
        setTotals(nextTotals);
        setPage(getPaginationPageValue(data.pagination, targetPage));
        return connectionList;
      } catch (error) {
        console.error("Error fetching connections:", error);
        setConnections([]);
        setProviderOptions([]);
        setPagination({ page: 1, pageSize, total: 0, totalPages: 1 });
        setTotals({ eligibleConnections: 0, providerFilteredConnections: 0 });
        return [];
      }
    },
    [accountFilter, page, pageSize, providerFilter],
  );

  const fetchQuota = useCallback(async (connectionId, provider, { force = false } = {}) => {
    setLoading((prev) => ({ ...prev, [connectionId]: true }));
    setErrors((prev) => ({ ...prev, [connectionId]: null }));

    try {
      const url = `/api/usage/${connectionId}${force ? "?force=1" : ""}`;
      const response = await fetch(url);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || response.statusText;

        if (response.status === 404) return;

        if (response.status === 401) {
          const quotaEntry = { quotas: [], message: errorMsg };
          setQuotaData((prev) => ({ ...prev, [connectionId]: quotaEntry }));
          setQuotaCache(connectionId, quotaEntry);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${errorMsg}`);
      }

      const data = await response.json();
      const parsedQuotas = parseQuotaData(provider, data);
      const quotaEntry = {
        quotas: parsedQuotas,
        plan: data.plan || null,
        message: data.message || null,
        raw: data,
      };

      setQuotaData((prev) => ({ ...prev, [connectionId]: quotaEntry }));
      setQuotaCache(connectionId, quotaEntry);
    } catch (error) {
      console.error(`[ProviderLimits] Error fetching quota for ${provider} (${connectionId}):`, error);
      setErrors((prev) => ({
        ...prev,
        [connectionId]: error.message || "Failed to fetch quota",
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      await fetchQuota(connectionId, provider, { force: true });
      setLastUpdated(new Date());
    },
    [fetchQuota],
  );

  const handleResetCodexLimit = useCallback(
    async (connectionId, provider) => {
      if (provider !== "codex" || resettingLimitId) return;
      setResettingLimitId(connectionId);
      setErrors((prev) => ({ ...prev, [connectionId]: null }));
      try {
        const response = await fetch(`/api/usage/${connectionId}/codex-reset-credits`, { method: "POST" });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(result.message || result.error || result.code || "Failed to reset Codex limit");
        }
        await fetchQuota(connectionId, provider);
        setLastUpdated(new Date());
      } catch (error) {
        setErrors((prev) => ({ ...prev, [connectionId]: error.message || "Failed to reset Codex limit" }));
      } finally {
        setResettingLimitId(null);
      }
    },
    [fetchQuota, resettingLimitId],
  );

  const handleViewCodexResetCredits = useCallback(async (connection) => {
    setResetCreditsState({ connection, loading: true, error: null, data: null });
    try {
      const response = await fetch(`/api/usage/${connection.id}/codex-reset-credits`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || result.message || "Failed to load Codex reset credits");
      }
      const credits = Array.isArray(result.credits) ? [...result.credits] : [];
      credits.sort((a, b) => {
        const aTime = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        const bTime = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
      setResetCreditsState({ connection, loading: false, error: null, data: { ...result, credits } });
    } catch (error) {
      setResetCreditsState({
        connection,
        loading: false,
        error: error.message || "Failed to load Codex reset credits",
        data: null,
      });
    }
  }, []);

  const executeDeleteConnection = useCallback(
    async (id) => {
      setDeletingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setLoading((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });

          if (typeof window !== "undefined") {
            try {
              const cache = getQuotaCache();
              if (cache[id]) {
                delete cache[id];
                window.localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify(cache));
              }
            } catch (e) {
              console.error("Error deleting cache entry:", e);
            }
          }

          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error deleting connection:", error);
      } finally {
        setDeletingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error updating connection status:", error);
      } finally {
        setTogglingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
          if (USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
            await fetchQuota(connectionId, provider);
          }
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = useCallback(
    async (force = false) => {
      if (refreshingAll) return;
      setRefreshingAll(true);
      setCountdown(60);

      const tick = (tickCountRef.current += 1);
      const claudeEvery = Math.round(CLAUDE_REFRESH_INTERVAL_MS / REFRESH_INTERVAL_MS);
      const shouldFetch = (conn) =>
        force || conn.provider !== "claude" || tick % claudeEvery === 0;

      try {
        const visibleConnections = await fetchConnections(page);
        setLoading(buildLoadingState(visibleConnections));
        setErrors((prev) => filterQuotaStateByConnections(prev, visibleConnections));
        setQuotaData((prev) => filterQuotaStateByConnections(prev, visibleConnections));

        await Promise.all(
          visibleConnections
            .filter(shouldFetch)
            .map((conn) => fetchQuota(conn.id, conn.provider)),
        );
        setLastUpdated(new Date());
      } catch (error) {
        console.error("Error refreshing all providers:", error);
      } finally {
        setRefreshingAll(false);
      }
    },
    [refreshingAll, fetchConnections, fetchQuota, page],
  );

  useEffect(() => {
    const initializeData = async () => {
      setConnectionsLoading(true);
      const visibleConnections = await fetchConnections(page);
      setConnectionsLoading(false);

      setLoading(buildLoadingState(visibleConnections));
      setErrors((prev) => filterQuotaStateByConnections(prev, visibleConnections));
      setQuotaData((prev) => filterQuotaStateByConnections(prev, visibleConnections));

      await Promise.all(visibleConnections.map((conn) => fetchQuota(conn.id, conn.provider)));
      setLastUpdated(new Date());
    };
    initializeData();
  }, [fetchConnections, fetchQuota, page]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    setAutoRefresh(stored === null ? true : stored === "true");
    setHasHydratedAutoRefresh(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedAutoRefresh) return;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefresh));
  }, [autoRefresh, hasHydratedAutoRefresh]);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) =>
        setAutoPingMaps({
          claude: s?.claudeAutoPing?.connections || {},
          codex: s?.codexAutoPing?.connections || {},
        }),
      )
      .catch(() => {});
  }, []);

  const toggleAutoPing = useCallback(
    async (connectionId, provider, on) => {
      const settingsKey = AUTO_PING_SETTINGS_KEYS[provider];
      if (!settingsKey) return;
      const previous = autoPingMaps;
      const nextProviderMap = { ...(autoPingMaps[provider] || {}), [connectionId]: on };
      const nextMaps = { ...autoPingMaps, [provider]: nextProviderMap };
      setAutoPingMaps(nextMaps);
      try {
        const r = await fetch("/api/settings", { cache: "no-store" });
        const s = r.ok ? await r.json() : {};
        const cfg = { ...(s[settingsKey] || {}), connections: nextProviderMap };
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [settingsKey]: cfg }),
        });
      } catch {
        setAutoPingMaps(previous);
      }
    },
    [autoPingMaps],
  );

  useEffect(() => {
    if (!hasHydratedAutoRefresh || !autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      refreshAll();
    }, REFRESH_INTERVAL_MS);

    countdownRef.current = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (countdownRef.current) {
          clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
      } else if (autoRefresh && hasHydratedAutoRefresh) {
        intervalRef.current = setInterval(() => refreshAll(), REFRESH_INTERVAL_MS);
        countdownRef.current = setInterval(() => {
          setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
        }, 1000);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  const sortedConnections = useMemo(
    () =>
      sortVisibleConnections(
        connections,
        quotaData,
        expiringFirst,
        providerFilter,
        quotaSortMode,
      ),
    [connections, quotaData, expiringFirst, providerFilter, quotaSortMode],
  );

  const visibleConnections = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sortedConnections;
    return sortedConnections.filter((conn) => {
      const label = (getConnectionLabel(conn) || "").toLowerCase();
      const secondary = (getConnectionSecondaryLabel(conn) || "").toLowerCase();
      const provider = (conn.provider || "").toLowerCase();
      const quotas = quotaData[conn.id]?.quotas || [];
      const modelHit = quotas.some((item) => (item.name || "").toLowerCase().includes(q));
      return provider.includes(q) || label.includes(q) || secondary.includes(q) || modelHit;
    });
  }, [sortedConnections, quotaData, searchQuery]);

  const isConnectionDepleted = useCallback(
    (conn) => {
      const quotas = quotaData[conn.id]?.quotas;
      if (!quotas?.length) return false;
      return quotas.some((q) => {
        if (!q.total || q.total <= 0) return false;
        return calculatePercentage(q.used, q.total) <= DEPLETED_QUOTA_THRESHOLD;
      });
    },
    [quotaData],
  );

  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        await reconcileConnectionsPage(fetchConnections, page);
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, fetchConnections, page],
  );

  const handleDisableDepleted = () => {
    const ids = sortedConnections
      .filter((c) => (c.isActive ?? true) && isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, false);
  };

  const handleEnableAvailable = () => {
    const ids = sortedConnections
      .filter((c) => !(c.isActive ?? true) && !isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, true);
  };

  const telemetrySummary = useMemo(() => {
    let healthyCount = 0;
    let criticalCount = 0;
    let earliestIso = null;
    let earliestMs = Number.POSITIVE_INFINITY;

    for (const conn of sortedConnections) {
      const quotas = quotaData[conn.id]?.quotas || [];
      const err = errors[conn.id];
      if (err) {
        criticalCount += 1;
        continue;
      }
      if (isConnectionDepleted(conn)) {
        criticalCount += 1;
      } else if (conn.isActive !== false) {
        healthyCount += 1;
      }
      const nextReset = findEarliestResetMs(quotas);
      if (nextReset) {
        const ms = new Date(nextReset).getTime();
        if (ms < earliestMs) {
          earliestMs = ms;
          earliestIso = nextReset;
        }
      }
    }

    return {
      healthyCount,
      criticalCount,
      earliestResetLabel: earliestIso ? formatResetTime(earliestIso) : "—",
    };
  }, [sortedConnections, quotaData, errors, isConnectionDepleted]);

  const hasEligibleConnections = totals.eligibleConnections > 0;
  const hasVisibleConnections = visibleConnections.length > 0;
  const emptyState = getConnectionsEmptyMessage(totals, providerFilter, accountFilter);
  const connectionsPageSummary = getConnectionsPaginationSummary(pagination);
  const isCustomPageSize = !ACCOUNT_PAGE_SIZE_OPTIONS.includes(pageSize);

  const providerSelectOptions = useMemo(
    () => [
      { value: "all", label: "All Providers" },
      ...providerOptions.map((provider) => ({
        value: provider,
        label: (
          <span className="inline-flex items-center gap-2 capitalize">
            <ProviderIcon
              src={`/providers/${provider}.png`}
              alt={provider}
              size={15}
              className="size-3.5 rounded object-contain shrink-0"
              fallbackText={provider.slice(0, 2).toUpperCase()}
            />
            <span>{provider}</span>
          </span>
        ),
      })),
    ],
    [providerOptions],
  );

  const matrixColumns = useMemo(
    () => [
      {
        title: "Account & Provider",
        key: "account",
        width: 260,
        render: (_, conn) => (
          <ConnectionIdentity conn={conn} copied={copied} onCopy={copy} />
        ),
      },
      {
        title: "Primary Quota Window",
        key: "quota",
        width: 270,
        render: (_, conn) => {
          const quota = quotaData[conn.id];
          const isLoading = loading[conn.id];
          const error = errors[conn.id];
          if (isLoading) {
            return <div className="h-3 w-36 rounded bg-bg-alt animate-pulse" />;
          }
          if (error) {
            return (
              <span className="inline-flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <ExclamationCircleOutlined />
                <span className="truncate max-w-[220px]" title={error}>{error}</span>
              </span>
            );
          }
          if (quota?.message) {
            return <span className="text-xs text-text-muted">{quota.message}</span>;
          }
          const primary = pickPrimaryQuota(quota?.quotas);
          if (!primary) {
            return <span className="text-xs text-text-subtle">No active windows</span>;
          }
          const remaining = getRemainingPercentage(primary);
          const tone = getQuotaTone(remaining);
          const extraCount = (quota?.quotas?.length || 0) - 1;

          return (
            <div className="space-y-1 min-w-0">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-text-main truncate">
                  <span className={`size-1.5 rounded-full shrink-0 ${tone.dotClass}`} />
                  <span className="truncate">{primary.name}</span>
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {extraCount > 0 && (
                    <span className="rounded border border-border bg-bg-alt px-1.5 py-0.2 font-mono text-[10px] text-text-muted">
                      +{extraCount}
                    </span>
                  )}
                  <span className={`font-mono font-semibold tabular-nums ${tone.textClass}`}>
                    {remaining}%
                  </span>
                </div>
              </div>
              <div className="h-1.5 w-full rounded-full overflow-hidden bg-bg-alt border border-border-subtle">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(remaining, 100)}%`, backgroundColor: tone.barColor }}
                />
              </div>
            </div>
          );
        },
      },
      {
        title: "Consumption",
        key: "usage",
        width: 150,
        render: (_, conn) => {
          const quota = quotaData[conn.id];
          if (loading[conn.id]) return <span className="text-xs text-text-muted font-mono">...</span>;
          const primary = pickPrimaryQuota(quota?.quotas);
          if (!primary || quota?.message || errors[conn.id]) {
            return <span className="font-mono text-xs text-text-subtle">—</span>;
          }
          return (
            <div className="font-mono text-xs tabular-nums">
              <span className="font-semibold text-text-main">
                {Number(primary.used || 0).toLocaleString()}
              </span>
              <span className="text-text-muted">
                {" / "}
                {primary.total > 0 ? Number(primary.total).toLocaleString() : "∞"}
              </span>
            </div>
          );
        },
      },
      {
        title: "Reset / Expiry",
        key: "reset",
        width: 150,
        render: (_, conn) => {
          const quota = quotaData[conn.id];
          if (loading[conn.id]) return <span className="text-xs text-text-muted">—</span>;
          const primary = pickPrimaryQuota(quota?.quotas);
          if (!primary) return <span className="font-mono text-xs text-text-subtle">—</span>;
          const nextCountdown = formatResetTime(primary.resetAt);
          const resetDisplay = formatResetTimeDisplay(primary.resetAt);
          const recurring = primary.recurring !== false;
          if (nextCountdown === "-" && !resetDisplay) {
            return <span className="font-mono text-xs text-text-subtle">N/A</span>;
          }
          return (
            <AntTooltip title={resetDisplay || ""}>
              <div className="space-y-0.5">
                <div className="font-mono text-xs font-medium text-text-main">
                  {nextCountdown !== "-" ? `${recurring ? "in" : "expires"} ${nextCountdown}` : resetDisplay}
                </div>
                {resetDisplay && (
                  <div className="text-[10px] text-text-muted">{resetDisplay}</div>
                )}
              </div>
            </AntTooltip>
          );
        },
      },
      {
        title: "Controls",
        key: "actions",
        align: "right",
        width: 220,
        render: (_, conn) => (
          <ConnectionActions
            conn={conn}
            quota={quotaData[conn.id]}
            isLoading={loading[conn.id]}
            rowBusy={deletingId === conn.id || togglingId === conn.id || resettingLimitId === conn.id}
            isResettingLimit={resettingLimitId === conn.id}
            deletingId={deletingId}
            autoPingEnabled={autoPingMaps[conn.provider]?.[conn.id] === true}
            onResetConfirm={(c, count) => setResetConfirmState({ connection: c, resetCreditCount: count })}
            onViewResetCredits={handleViewCodexResetCredits}
            onToggleAutoPing={toggleAutoPing}
            onRefresh={refreshProvider}
            onEdit={(c) => {
              setSelectedConnection(c);
              setShowEditModal(true);
            }}
            onDelete={(c) => setDeleteConfirmConn(c)}
            onToggleActive={handleToggleConnectionActive}
          />
        ),
      },
    ],
    [
      copied,
      copy,
      quotaData,
      loading,
      errors,
      deletingId,
      togglingId,
      resettingLimitId,
      autoPingMaps,
      handleViewCodexResetCredits,
      toggleAutoPing,
      refreshProvider,
      handleToggleConnectionActive,
    ],
  );

  const codexCreditColumns = useMemo(
    () => [
      {
        title: "Status",
        dataIndex: "status",
        key: "status",
        render: (status) => <Tag className="font-mono text-[11px]">{status || "unknown"}</Tag>,
      },
      {
        title: "Granted At",
        dataIndex: "grantedAt",
        key: "grantedAt",
        render: (val) => <span className="font-mono text-xs text-text-muted">{formatCreditDate(val)}</span>,
      },
      {
        title: "Expires At",
        dataIndex: "expiresAt",
        key: "expiresAt",
        render: (val) => <span className="font-mono text-xs text-text-main">{formatCreditDate(val)}</span>,
      },
      {
        title: "Remaining",
        dataIndex: "expiresAt",
        key: "remaining",
        render: (val) => <span className="font-mono text-xs font-semibold text-text-main">{formatTimeRemaining(val)}</span>,
      },
    ],
    [],
  );

  if (!connectionsLoading && !hasEligibleConnections) {
    return (
      <div className="space-y-5">
        <PageHero
          title="Quota & Rate-Limit Console"
          description="Monitor live account quota headroom, reset countdowns, and automatic cooldown protections across OAuth and API pools."
          icon={<DashboardOutlined />}
          badge={{ text: "No Eligible Accounts" }}
        />
        <Card padding="lg" className="border border-border bg-surface">
          <div className="text-center py-12">
            <div className="inline-flex size-12 items-center justify-center rounded-xl border border-border bg-surface-2 text-text-muted mb-3">
              <DashboardOutlined className="text-xl" />
            </div>
            <h3 className="text-base font-semibold text-text-main">No Providers Connected</h3>
            <p className="mt-1.5 text-xs text-text-muted max-w-md mx-auto">
              Connect OAuth or usage-enabled provider accounts to inspect real-time quota windows and cooldowns.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5 min-w-0">
      <PageHero
        title="Quota & Rate-Limit Console"
        description={
          lastUpdated
            ? `Real-time quota headroom, reset windows, and auto-ping triggers · Updated ${lastUpdated.toLocaleTimeString()}`
            : "Monitor per-account 5h/daily quota windows, rate-limit cooldowns, and auto-ping triggers across connected accounts."
        }
        icon={<DashboardOutlined />}
        badge={{ text: autoRefresh ? `Auto-sync ${countdown}s` : "Manual Sync" }}
        stats={[
          { label: "Eligible Pool", value: totals.eligibleConnections ?? connections.length },
          { label: "Healthy Accounts", value: telemetrySummary.healthyCount, suffix: "ready" },
          { label: "At Risk / Depleted", value: telemetrySummary.criticalCount },
          { label: "Earliest Reset", value: telemetrySummary.earliestResetLabel },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <AntTooltip title="Disable connections with depleted quota on the current page">
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                disabled={bulkToggling}
                onClick={handleDisableDepleted}
              >
                Disable Empty
              </Button>
            </AntTooltip>
            <AntTooltip title="Enable connections that still have available quota on this page">
              <Button
                size="small"
                icon={<CheckCircleOutlined />}
                disabled={bulkToggling}
                onClick={handleEnableAvailable}
              >
                Enable Ready
              </Button>
            </AntTooltip>
            <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-alt px-2.5 py-1 text-xs">
              <span className="text-text-muted font-medium">Auto</span>
              <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
              {autoRefresh && (
                <span className="font-mono text-[11px] text-text-muted tabular-nums">{countdown}s</span>
              )}
            </div>
            <Button
              type="primary"
              size="small"
              icon={<ReloadOutlined spin={refreshingAll} />}
              disabled={refreshingAll}
              onClick={() => refreshAll(true)}
            >
              Refresh All
            </Button>
          </div>
        }
        toolbar={
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between w-full min-w-0">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <Select
                size="small"
                value={providerFilter}
                onChange={(val) => {
                  if (shouldResetPage(providerFilter, val)) setPage(1);
                  setProviderFilter(val);
                }}
                options={providerSelectOptions}
                className="min-w-[155px]"
                aria-label="Filter quota providers"
              />
              <Select
                size="small"
                value={accountFilter}
                onChange={(val) => {
                  if (shouldResetPage(accountFilter, val)) setPage(1);
                  setAccountFilter(val);
                }}
                options={ACCOUNT_FILTER_OPTIONS}
                className="min-w-[140px]"
                aria-label="Filter accounts by status"
              />
              {providerFilter === "codex" && (
                <Select
                  size="small"
                  value={quotaSortMode}
                  onChange={setQuotaSortMode}
                  options={QUOTA_SORT_OPTIONS}
                  className="min-w-[165px]"
                  aria-label="Sort Codex quotas by remaining"
                />
              )}
              <Button
                size="small"
                type={expiringFirst ? "primary" : "default"}
                icon={<HourglassOutlined />}
                onClick={() => setExpiringFirst((prev) => !prev)}
                aria-pressed={expiringFirst}
                title="Sort accounts by earliest quota reset time"
              >
                Expiring First
              </Button>
              <Input
                allowClear
                size="small"
                prefix={<SearchOutlined className="text-text-muted" />}
                placeholder="Filter account or model..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full sm:w-52"
              />
            </div>

            <div className="max-w-full overflow-x-auto pb-0.5 shrink-0">
              <Segmented
                size="small"
                value={viewMode}
                onChange={setViewMode}
                options={[
                  { label: "Matrix", value: "matrix" },
                  { label: "Cards", value: "cards" },
                ]}
              />
            </div>
          </div>
        }
      />

      {expiringFirst && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Expiring-first sorts accounts within the current page; cross-page order continues to follow server priority pagination.
        </div>
      )}

      {!connectionsLoading && !hasVisibleConnections ? (
        <Card padding="lg" className="border border-border bg-surface">
          <div className="text-center py-10">
            <h3 className="text-sm font-semibold text-text-main">
              {searchQuery ? `No accounts match "${searchQuery}"` : emptyState.title}
            </h3>
            <p className="mt-1 text-xs text-text-muted max-w-md mx-auto">
              {searchQuery ? "Try clearing the search query or widening your provider/status filter." : emptyState.description}
            </p>
            <Button
              size="small"
              className="mt-4"
              onClick={() => {
                setProviderFilter("all");
                setAccountFilter("all");
                setSearchQuery("");
                setExpiringFirst(false);
                setPage(1);
              }}
            >
              Reset Filters
            </Button>
          </div>
        </Card>
      ) : viewMode === "matrix" ? (
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          <Table
            size="small"
            bordered
            rowKey="id"
            columns={matrixColumns}
            dataSource={visibleConnections}
            loading={connectionsLoading}
            pagination={false}
            scroll={{ x: 960 }}
            expandable={{
              rowExpandable: (conn) => {
                const list = quotaData[conn.id]?.quotas;
                return Array.isArray(list) && list.length > 0 && !quotaData[conn.id]?.message;
              },
              expandedRowRender: (conn) => (
                <div className="p-2 bg-bg-alt/50 rounded-lg">
                  <QuotaTable
                    quotas={quotaData[conn.id]?.quotas}
                    compact={false}
                    sortMode={conn.provider === "codex" ? quotaSortMode : "default"}
                    showSortLabel={conn.provider === "codex" && quotaSortMode !== "default"}
                  />
                </div>
              ),
            }}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {visibleConnections.map((conn) => {
            const quota = quotaData[conn.id];
            const isLoading = loading[conn.id];
            const error = errors[conn.id];
            const isInactive = conn.isActive === false;
            const rowBusy = deletingId === conn.id || togglingId === conn.id || resettingLimitId === conn.id;

            return (
              <Card
                key={conn.id}
                padding="none"
                className={`min-w-0 border border-border bg-surface overflow-hidden ${isInactive ? "opacity-65" : ""}`}
              >
                <div className="px-3.5 py-2.5 border-b border-border-subtle bg-bg-alt/40 flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <ConnectionIdentity conn={conn} copied={copied} onCopy={copy} />
                  </div>
                  <ConnectionActions
                    conn={conn}
                    quota={quota}
                    isLoading={isLoading}
                    rowBusy={rowBusy}
                    isResettingLimit={resettingLimitId === conn.id}
                    deletingId={deletingId}
                    autoPingEnabled={autoPingMaps[conn.provider]?.[conn.id] === true}
                    onResetConfirm={(c, count) => setResetConfirmState({ connection: c, resetCreditCount: count })}
                    onViewResetCredits={handleViewCodexResetCredits}
                    onToggleAutoPing={toggleAutoPing}
                    onRefresh={refreshProvider}
                    onEdit={(c) => {
                      setSelectedConnection(c);
                      setShowEditModal(true);
                    }}
                    onDelete={(c) => setDeleteConfirmConn(c)}
                    onToggleActive={handleToggleConnectionActive}
                  />
                </div>

                <div className="p-3">
                  {isLoading ? (
                    <div className="space-y-2 py-2">
                      <div className="h-3 w-2/3 rounded bg-bg-alt animate-pulse" />
                      <div className="h-2 w-full rounded bg-bg-alt animate-pulse" />
                    </div>
                  ) : error ? (
                    <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                      <ExclamationCircleOutlined className="shrink-0" />
                      <span className="truncate">{error}</span>
                    </div>
                  ) : quota?.message ? (
                    <div className="text-center py-4 text-xs text-text-muted">{quota.message}</div>
                  ) : (
                    <QuotaTable
                      quotas={quota?.quotas}
                      compact
                      sortMode={conn.provider === "codex" ? quotaSortMode : "default"}
                      showSortLabel={conn.provider === "codex" && quotaSortMode !== "default"}
                    />
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Server-Backed Pagination & Page-Size Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-2.5">
        <span className="text-xs text-text-muted font-mono tabular-nums">{connectionsPageSummary}</span>
        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            size="small"
            value={customPageMode || isCustomPageSize ? "custom" : String(pageSize)}
            onChange={(nextValue) => {
              if (nextValue === "custom") {
                setCustomPageMode(true);
                return;
              }
              const nextPageSize = Number.parseInt(nextValue, 10);
              if (Number.isFinite(nextPageSize)) {
                setCustomPageMode(false);
                setPage(1);
                setPageSize(nextPageSize);
                setCustomPageSizeInput(String(nextPageSize));
              }
            }}
            options={[
              ...ACCOUNT_PAGE_SIZE_OPTIONS.map((opt) => ({ value: String(opt), label: `${opt} / page` })),
              { value: "custom", label: "Custom" },
            ]}
            className="w-[110px]"
            aria-label="Accounts per page"
          />
          {(customPageMode || isCustomPageSize) && (
            <Input
              size="small"
              type="number"
              min="1"
              max={String(ACCOUNT_PAGE_SIZE_MAX)}
              inputMode="numeric"
              value={customPageSizeInput}
              onChange={(e) => setCustomPageSizeInput(e.target.value)}
              onBlur={() => {
                const parsedValue = Number.parseInt(customPageSizeInput, 10);
                if (!Number.isFinite(parsedValue)) {
                  setCustomPageSizeInput(String(pageSize));
                  return;
                }
                const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                setPage(1);
                setPageSize(nextPageSize);
                setCustomPageSizeInput(String(nextPageSize));
              }}
              onPressEnter={() => {
                const parsedValue = Number.parseInt(customPageSizeInput, 10);
                if (!Number.isFinite(parsedValue)) {
                  setCustomPageSizeInput(String(pageSize));
                  return;
                }
                const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                setPage(1);
                setPageSize(nextPageSize);
                setCustomPageSizeInput(String(nextPageSize));
              }}
              className="w-20 font-mono"
              aria-label="Custom accounts per page"
              placeholder={getPageSizeLabel(pageSize, isCustomPageSize)}
            />
          )}
          <Pagination
            size="small"
            current={pagination.page}
            pageSize={pagination.pageSize || pageSize}
            total={pagination.total || connections.length}
            showSizeChanger={false}
            disabled={connectionsLoading || refreshingAll}
            onChange={(nextPage) => setPage(nextPage)}
          />
        </div>
      </div>

      <ConfirmModal
        isOpen={Boolean(resetConfirmState)}
        onClose={() => {
          if (!resettingLimitId) setResetConfirmState(null);
        }}
        onConfirm={async () => {
          const connection = resetConfirmState?.connection;
          if (!connection) return;
          await handleResetCodexLimit(connection.id, connection.provider);
          setResetConfirmState(null);
        }}
        title="Reset Codex limit?"
        message={`Use 1 Codex reset credit for ${getConnectionLabel(resetConfirmState?.connection || {}) || "this account"}. This cannot be undone. Remaining credits: ${resetConfirmState?.resetCreditCount ?? 0}.`}
        confirmText="Reset limit"
        cancelText="Cancel"
        variant="danger"
        loading={Boolean(resettingLimitId)}
      />

      <ConfirmModal
        isOpen={Boolean(deleteConfirmConn)}
        onClose={() => {
          if (!deletingId) setDeleteConfirmConn(null);
        }}
        onConfirm={async () => {
          const target = deleteConfirmConn;
          setDeleteConfirmConn(null);
          if (target?.id) await executeDeleteConnection(target.id);
        }}
        title="Delete connection?"
        message={`Remove ${getConnectionLabel(deleteConfirmConn || {}) || deleteConfirmConn?.provider || "this connection"}? Associated local quota cache will be cleared.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        loading={Boolean(deletingId)}
      />

      <Modal
        open={Boolean(resetCreditsState)}
        onCancel={() => setResetCreditsState(null)}
        footer={null}
        destroyOnHidden
        width={680}
        title={
          <div>
            <div className="text-sm font-semibold text-text-main">Codex Reset Credit Expiry</div>
            <div className="text-xs font-normal text-text-muted">
              {getConnectionLabel(resetCreditsState?.connection || {}) || "Codex account"}
            </div>
          </div>
        }
      >
        {resetCreditsState?.loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-muted">
            Loading reset credits...
          </div>
        ) : resetCreditsState?.error ? (
          <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
            {resetCreditsState.error}
          </div>
        ) : resetCreditsState?.data?.credits?.length ? (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between rounded-lg border border-border bg-bg-alt px-3 py-2 font-mono text-xs text-text-muted">
              <span>
                {resetCreditsState.data.credits.length} reset credit
                {resetCreditsState.data.credits.length === 1 ? "" : "s"}
              </span>
              <span>{resetCreditsState.data.availableCount ?? 0} available</span>
            </div>
            <Table
              size="small"
              bordered
              pagination={false}
              rowKey={(credit, index) => `${credit.status}-${credit.expiresAt || index}`}
              columns={codexCreditColumns}
              dataSource={resetCreditsState.data.credits}
            />
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-alt px-3 py-8 text-center text-xs text-text-muted mt-2">
            No reset credit details returned for this account.
          </div>
        )}
      </Modal>

      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
        }}
      />
    </div>
  );
}
