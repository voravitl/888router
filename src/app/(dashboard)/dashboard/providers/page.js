"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import {
  Card,
  CardSkeleton,
  Badge,
  Button,
  Toggle,
  PageHero,
} from "@/shared/components";
import { Segmented, Input as AntInput, Tag, Table as AntTable, Drawer as AntDrawer, Switch } from "antd";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import {
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import Link from "next/link";
import { getErrorCode, getRelativeTime } from "@/shared/utils";
import { useNotificationStore } from "@/store/notificationStore";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import ModelAvailabilityBadge from "./components/ModelAvailabilityBadge";
import AddCompatibleModal from "./components/AddCompatibleModal";

function getStatusDisplay(connected, error, errorCode) {
  const parts = [];
  if (connected > 0) {
    parts.push(
      <Badge key="connected" variant="success" size="sm" dot>
        {connected} Connected
      </Badge>,
    );
  }
  if (error > 0) {
    const errText = errorCode
      ? `${error} Error (${errorCode})`
      : `${error} Error`;
    parts.push(
      <Badge key="error" variant="error" size="sm" dot>
        {errText}
      </Badge>,
    );
  }
  if (parts.length === 0) {
    return <span className="text-text-muted">No connections</span>;
  }
  return parts;
}

function getConnectionErrorTag(connection) {
  if (!connection) return null;

  const explicitType = connection.lastErrorType;
  if (explicitType === "runtime_error") return "RUNTIME";
  if (
    explicitType === "upstream_auth_error" ||
    explicitType === "auth_missing" ||
    explicitType === "token_refresh_failed" ||
    explicitType === "token_expired"
  )
    return "AUTH";
  if (explicitType === "upstream_rate_limited") return "429";
  if (explicitType === "upstream_unavailable") return "5XX";
  if (explicitType === "network_error") return "NET";

  const numericCode = Number(connection.errorCode);
  if (Number.isFinite(numericCode) && numericCode >= 400)
    return String(numericCode);

  const fromMessage = getErrorCode(connection.lastError);
  if (fromMessage === "401" || fromMessage === "403") return "AUTH";
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (connection.lastError || "").toLowerCase();
  if (
    msg.includes("runtime") ||
    msg.includes("not runnable") ||
    msg.includes("not installed")
  )
    return "RUNTIME";
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("unauthorized")
  )
    return "AUTH";

  return "ERR";
}

const APIKEY_INITIAL_VISIBLE = 20;

export default function ProvidersPage() {
  const [connections, setConnections] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAllApikey, setShowAllApikey] = useState(false);
  const [showAddCompatibleModal, setShowAddCompatibleModal] = useState(false);
  const [showAddAnthropicCompatibleModal, setShowAddAnthropicCompatibleModal] =
    useState(false);
  const [testingMode, setTestingMode] = useState(null);
  const [testResults, setTestResults] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [viewMode, setViewMode] = useState("matrix");
  const [drawerProvider, setDrawerProvider] = useState(null);
  const [localSearch, setLocalSearch] = useState("");
  const notify = useNotificationStore();
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  useEffect(() => {
    registerSearch("Search providers...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  const effectiveSearch = (localSearch || searchQuery || "").trim().toLowerCase();
  const matchSearch = (name) =>
    !effectiveSearch ||
    name.toLowerCase().includes(effectiveSearch);

  const sortByPriority = (entries, authType) =>
    [...entries].sort(([ka, a], [kb, b]) => {
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;
      const sa = getProviderStats(ka, authType);
      const sb = getProviderStats(kb, authType);
      const ca = sa.connected > 0 ? 1 : 0;
      const cb = sb.connected > 0 ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return (a.name || "").localeCompare(b.name || "");
    });

  const sortItemsByPriority = (items, authType) =>
    [...items].sort((a, b) => {
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;
      const sa = getProviderStats(a.id, authType);
      const sb = getProviderStats(b.id, authType);
      const ca = sa.connected > 0 ? 1 : 0;
      const cb = sb.connected > 0 ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return (a.name || "").localeCompare(b.name || "");
    });

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [connectionsRes, nodesRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/provider-nodes"),
        ]);
        const connectionsData = await connectionsRes.json();
        const nodesData = await nodesRes.json();
        if (connectionsRes.ok)
          setConnections(connectionsData.connections || []);
        if (nodesRes.ok) setProviderNodes(nodesData.nodes || []);
      } catch (error) {
        console.log("Error fetching data:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const getProviderStats = (providerId, authType) => {
    const authTypes = Array.isArray(authType) ? authType : [authType];
    const providerConnections = connections.filter(
      (c) => c.provider === providerId && authTypes.includes(c.authType),
    );

    const getEffectiveStatus = (conn) => {
      const isCooldown = Object.entries(conn).some(
        ([k, v]) =>
          k.startsWith("modelLock_") && v && new Date(v).getTime() > Date.now(),
      );
      return conn.testStatus === "unavailable" && !isCooldown
        ? "active"
        : conn.testStatus;
    };

    const connected = providerConnections.filter((c) => {
      const status = getEffectiveStatus(c);
      return status === "active" || status === "success";
    }).length;

    const errorConns = providerConnections.filter((c) => {
      const status = getEffectiveStatus(c);
      return (
        status === "error" || status === "expired" || status === "unavailable"
      );
    });

    const error = errorConns.length;
    const total = providerConnections.length;
    const allDisabled =
      total > 0 && providerConnections.every((c) => c.isActive === false);

    const latestError = errorConns.sort(
      (a, b) => new Date(b.lastErrorAt || 0) - new Date(a.lastErrorAt || 0),
    )[0];
    const errorCode = latestError ? getConnectionErrorTag(latestError) : null;
    const errorTime = latestError?.lastErrorAt
      ? getRelativeTime(latestError.lastErrorAt)
      : null;

    return { connected, error, total, errorCode, errorTime, allDisabled };
  };

  // Toggle all connections for a provider on/off. authType may be a single
  // string or an array (kiro counts oauth + api_key/apikey together).
  const handleToggleProvider = async (providerId, authType, newActive) => {
    const authTypes = Array.isArray(authType) ? authType : [authType];
    const matches = (c) =>
      c.provider === providerId && authTypes.includes(c.authType);
    const providerConns = connections.filter(matches);
    setConnections((prev) =>
      prev.map((c) => (matches(c) ? { ...c, isActive: newActive } : c)),
    );
    await Promise.allSettled(
      providerConns.map((c) =>
        fetch(`/api/providers/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: newActive }),
        }),
      ),
    );
  };

  const handleBatchTest = async (mode, providerId = null) => {
    if (testingMode) return;
    setTestingMode(mode === "provider" ? providerId : mode);
    setTestResults(null);
    try {
      const res = await fetch("/api/providers/test-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, providerId }),
      });
      const data = await res.json();
      setTestResults(data);
      if (data.summary) {
        const { passed, failed, total } = data.summary;
        if (failed === 0) notify.success(`All ${total} tests passed`);
        else notify.warning(`${passed}/${total} passed, ${failed} failed`);
      }
    } catch (error) {
      setTestResults({ error: "Test request failed" });
      notify.error("Provider test failed");
    } finally {
      setTestingMode(null);
    }
  };

  const compatibleProviders = providerNodes
    .filter((node) => node.type === "openai-compatible")
    .map((node) => ({
      id: node.id,
      name: node.name || "OpenAI Compatible",
      color: "#10A37F",
      textIcon: "OC",
      apiType: node.apiType,
    }))
    .filter((p) => matchSearch(p.name));

  const anthropicCompatibleProviders = providerNodes
    .filter((node) => node.type === "anthropic-compatible")
    .map((node) => ({
      id: node.id,
      name: node.name || "Anthropic Compatible",
      color: "#D97757",
      textIcon: "AC",
    }))
    .filter((p) => matchSearch(p.name));

  const oauthEntries = sortByPriority(
    Object.entries(OAUTH_PROVIDERS).filter(([, info]) => !info.hidden && matchSearch(info.name)),
    "oauth",
  );
  const freeEntries = Object.entries(FREE_PROVIDERS)
    .filter(([, info]) => !info.hidden && matchSearch(info.name))
    .sort(([, a], [, b]) => (b.noAuth ? 1 : 0) - (a.noAuth ? 1 : 0));
  const freeTierEntries = sortByPriority(
    Object.entries(FREE_TIER_PROVIDERS).filter(
      ([, info]) =>
        !info.hidden &&
        matchSearch(info.name) &&
        (info.serviceKinds ?? ["llm"]).includes("llm"),
    ),
    "freeTier",
  ).sort(([, a], [, b]) => (b.noAuth ? 1 : 0) - (a.noAuth ? 1 : 0));
  // API Key: connected providers first, then alphabetical by name
  const apikeyEntries = Object.entries(APIKEY_PROVIDERS)
    .filter(
      ([, info]) =>
        !info.hidden &&
        (info.serviceKinds ?? ["llm"]).includes("llm") &&
        matchSearch(info.name),
    )
    .sort(([ka, a], [kb, b]) => {
      const ca = getProviderStats(ka, "apikey").total > 0 ? 0 : 1;
      const cb = getProviderStats(kb, "apikey").total > 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return (a.name || "").localeCompare(b.name || "");
    });
  const isApikeySearching = !!effectiveSearch;
  const visibleApikeyEntries =
    isApikeySearching || showAllApikey || categoryFilter === "apikey"
      ? apikeyEntries
      : apikeyEntries.slice(0, APIKEY_INITIAL_VISIBLE);
  const hiddenApikeyCount = apikeyEntries.length - APIKEY_INITIAL_VISIBLE;

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const onlyConnected = categoryFilter === "connected";
  const filterConnectedList = (items, getStatsFn) =>
    onlyConnected ? items.filter((item) => getStatsFn(item).total > 0) : items;

  const displayedCompatible = filterConnectedList(
    [...compatibleProviders, ...anthropicCompatibleProviders],
    (info) => getProviderStats(info.id, "apikey"),
  );
  const displayedOAuth = filterConnectedList(oauthEntries, ([key]) =>
    getProviderStats(key, "oauth"),
  );
  const displayedFree = filterConnectedList(freeEntries, ([key]) =>
    getProviderStats(key, key === "kiro" ? ["oauth", "apikey", "api_key"] : "oauth"),
  );
  const displayedFreeTier = filterConnectedList(freeTierEntries, ([key]) =>
    getProviderStats(key, "apikey"),
  );
  const displayedApikey = filterConnectedList(visibleApikeyEntries, ([key]) =>
    getProviderStats(key, "apikey"),
  );

  const showCompatibleSection =
    (categoryFilter === "all" || categoryFilter === "compatible" || onlyConnected) &&
    (!onlyConnected || displayedCompatible.length > 0);
  const showOAuthSection =
    (categoryFilter === "all" || categoryFilter === "oauth" || onlyConnected) &&
    displayedOAuth.length > 0;
  const showFreeSection =
    (categoryFilter === "all" || categoryFilter === "free" || onlyConnected) &&
    (displayedFree.length > 0 || displayedFreeTier.length > 0);
  const showApikeySection =
    (categoryFilter === "all" || categoryFilter === "apikey" || onlyConnected) &&
    displayedApikey.length > 0;

  const hasAnyResult =
    (categoryFilter === "compatible" && true) ||
    displayedCompatible.length > 0 ||
    displayedOAuth.length > 0 ||
    displayedFree.length > 0 ||
    displayedFreeTier.length > 0 ||
    displayedApikey.length > 0;

  const totalActiveConns = connections.filter((c) => c.isActive !== false).length;
  const errorConnsCount = connections.filter((c) => {
    const isCooldown = Object.entries(c).some(
      ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > Date.now(),
    );
    return (
      c.testStatus === "error" ||
      c.testStatus === "expired" ||
      (c.testStatus === "unavailable" && isCooldown)
    );
  }).length;
  const connectedProviderCount = new Set(connections.map((c) => c.provider)).size;

  const gridClass =
    viewMode === "list"
      ? "grid grid-cols-1 lg:grid-cols-2 gap-2.5"
      : "grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-3.5 lg:grid-cols-3 xl:grid-cols-4";

  const matchProvConns = (provId, allowedAuthTypes) =>
    connections.filter((c) => {
      if (c.provider !== provId) return false;
      if (!allowedAuthTypes) return true;
      const t = c.authType || "oauth";
      return Array.isArray(allowedAuthTypes) ? allowedAuthTypes.includes(t) : t === allowedAuthTypes;
    });

  const buildMatrixRow = (id, name, tier, badgeColor, authTypes, stats, isCompatible = false) => {
    const provConns = matchProvConns(id, authTypes);
    const activeCount = provConns.filter((c) => c.isActive !== false).length;
    const errorCount = provConns.filter(
      (c) => c.testStatus === "error" || c.testStatus === "expired" || c.testStatus === "unavailable"
    ).length;
    return {
      key: `${tier}-${id}`,
      id,
      name,
      tier,
      badgeColor,
      authTypes,
      isCompatible,
      stats,
      conns: provConns,
      activeCount,
      totalCount: provConns.length,
      errorCount,
    };
  };

  const rawMatrixRows = [
    ...(showCompatibleSection
      ? displayedCompatible.map((info) =>
          buildMatrixRow(
            info.id,
            info.name,
            info.apiType ? `COMPAT (${info.apiType.toUpperCase()})` : "COMPATIBLE",
            "#71717a",
            "apikey",
            getProviderStats(info.id, "apikey"),
            true
          )
        )
      : []),
    ...(showOAuthSection
      ? displayedOAuth.map(([key, info]) =>
          buildMatrixRow(key, info.name, "OAUTH", "#2563eb", "oauth", getProviderStats(key, "oauth"))
        )
      : []),
    ...(showFreeSection
      ? [
          ...displayedFree.map(([key, info]) => {
            const freeTypes = key === "kiro" ? ["oauth", "apikey", "api_key"] : "oauth";
            return buildMatrixRow(key, info.name, "FREE", "#10b981", freeTypes, getProviderStats(key, freeTypes));
          }),
          ...displayedFreeTier.map(([key, info]) =>
            buildMatrixRow(key, info.name, "FREE TIER", "#10b981", "apikey", getProviderStats(key, "apikey"))
          ),
        ]
      : []),
    ...(showApikeySection
      ? displayedApikey.map(([key, info]) =>
          buildMatrixRow(key, info.name, "API KEY", "#eab308", "apikey", getProviderStats(key, "apikey"))
        )
      : []),
  ];

  const matrixRows =
    categoryFilter === "all"
      ? [...rawMatrixRows].sort((a, b) => (b.totalCount > 0 ? 1 : 0) - (a.totalCount > 0 ? 1 : 0))
      : rawMatrixRows;

  const matrixColumns = [
    {
      title: "Provider",
      dataIndex: "name",
      render: (_, record) => {
        const dotColor =
          record.errorCount > 0
            ? "#dc2626"
            : record.activeCount > 0
              ? "#a6c23f"
              : "var(--color-border-strong)";
        return (
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="size-2 rounded-full shrink-0 inline-block" style={{ backgroundColor: dotColor }} />
            <div className="size-7 rounded-lg border border-border bg-bg-alt flex items-center justify-center shrink-0">
              <ProviderIcon
                src={`/providers/${record.id}.png`}
                alt={record.name}
                size={16}
                className="object-contain max-w-[16px] max-h-[16px]"
                fallbackText={record.name.slice(0, 2).toUpperCase()}
              />
            </div>
            <Link
              href={`/dashboard/providers/${record.id}`}
              prefetch={false}
              onClick={(e) => e.stopPropagation()}
              className="font-medium text-text-main hover:underline truncate"
            >
              {record.name}
            </Link>
          </div>
        );
      },
    },
    {
      title: "Tier",
      dataIndex: "tier",
      width: 120,
      render: (tier) => (
        <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-medium border border-border bg-bg-alt text-text-muted">
          {tier}
        </span>
      ),
    },
    {
      title: "Accounts",
      dataIndex: "totalCount",
      width: 140,
      render: (_, record) => (
        <span className="text-xs tabular-nums text-text-main">
          <strong>{record.activeCount}</strong>
          <span className="text-text-muted"> / {record.totalCount} active</span>
        </span>
      ),
    },
    {
      title: "Status",
      dataIndex: "errorCount",
      width: 140,
      render: (_, record) => {
        if (record.totalCount === 0) {
          return <span className="text-[11px] text-text-subtle">Unconfigured</span>;
        }
        if (record.errorCount > 0) {
          return (
            <span className="inline-block px-2 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 text-[11px] font-medium text-red-600 dark:text-red-400">
              {record.errorCount} error
            </span>
          );
        }
        if (record.activeCount === 0) {
          return (
            <span className="inline-block px-2 py-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              Paused
            </span>
          );
        }
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
            <span className="size-1.5 rounded-full bg-[#a6c23f]" />
            Online
          </span>
        );
      },
    },
    {
      title: "Actions",
      key: "actions",
      width: 260,
      align: "right",
      render: (_, record) => (
        <div className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {record.totalCount > 0 && (
            <Switch
              size="small"
              checked={!record.stats?.allDisabled}
              onChange={(checked) => handleToggleProvider(record.id, record.authTypes, checked)}
              aria-label={`Toggle ${record.name}`}
            />
          )}
          <button
            type="button"
            onClick={() => handleBatchTest("provider", record.id)}
            disabled={record.totalCount === 0 || testingMode === record.id}
            className="px-2.5 py-1 rounded-md border border-border bg-bg-alt hover:bg-surface-2 disabled:opacity-40 text-[11px] font-medium text-text-main transition-colors cursor-pointer"
          >
            {testingMode === record.id ? "Testing" : "Test"}
          </button>
          <button
            type="button"
            onClick={() => setDrawerProvider(record)}
            className="px-2.5 py-1 rounded-md border border-border bg-bg-alt hover:bg-surface-2 text-[11px] font-medium text-text-main transition-colors cursor-pointer"
          >
            Inspect
          </button>
          <Link
            href={`/dashboard/providers/${record.id}`}
            prefetch={false}
            className="px-2.5 py-1 rounded-md bg-[#111111] text-white dark:bg-[#fafafa] dark:text-[#111111] text-[11px] font-medium hover:opacity-85 transition-opacity"
          >
            Config →
          </Link>
        </div>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <PageHero
        title="AI Providers"
        description="Unified gateway catalog for OAuth accounts, free providers, API key backends, and compatible endpoints."
        badge={{
          text: `${totalActiveConns}/${connections.length} active${errorConnsCount > 0 ? ` · ${errorConnsCount} error` : ""}`,
          color: errorConnsCount > 0 ? "orange" : "green",
        }}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ModelAvailabilityBadge />
            <Button
              size="sm"
              variant="outline"
              icon="add"
              onClick={() => setShowAddAnthropicCompatibleModal(true)}
            >
              Anthropic Node
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon="add"
              onClick={() => setShowAddCompatibleModal(true)}
            >
              OpenAI Node
            </Button>
          </div>
        }
        toolbar={
          <>
            <div className="w-full sm:w-auto max-w-full overflow-x-auto custom-scrollbar">
              <Segmented
                size="small"
                value={categoryFilter}
                onChange={setCategoryFilter}
                options={[
                  { label: "All", value: "all" },
                  { label: `Connected (${connectedProviderCount})`, value: "connected" },
                  { label: `OAuth (${oauthEntries.length})`, value: "oauth" },
                  { label: `Free (${freeEntries.length + freeTierEntries.length})`, value: "free" },
                  { label: `API Key (${apikeyEntries.length})`, value: "apikey" },
                  {
                    label: `Custom (${compatibleProviders.length + anthropicCompatibleProviders.length})`,
                    value: "compatible",
                  },
                ]}
              />
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <AntInput
                allowClear
                size="small"
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                placeholder="Filter provider by name..."
                prefix={<span className="material-symbols-outlined text-[15px] text-text-muted">search</span>}
                className="w-full sm:w-56"
              />
              <Segmented
                size="small"
                value={viewMode}
                onChange={setViewMode}
                options={[
                  { label: "Matrix", value: "matrix" },
                  { label: "Cards", value: "grid" },
                ]}
              />
            </div>
          </>
        }
      />

      {viewMode === "matrix" && hasAnyResult && (
        <div className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-border bg-bg-alt">
            <span className="text-xs font-semibold text-text-main">
              Provider Catalog ({matrixRows.length})
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleBatchTest("oauth")}
                disabled={testingMode === "oauth"}
                className="px-2.5 py-1 rounded-md border border-border bg-surface hover:bg-surface-2 text-[11px] font-medium text-text-main transition-colors cursor-pointer"
              >
                {testingMode === "oauth" ? "Testing OAuth..." : "Test OAuth"}
              </button>
              <button
                type="button"
                onClick={() => handleBatchTest("free")}
                disabled={testingMode === "free"}
                className="px-2.5 py-1 rounded-md border border-border bg-surface hover:bg-surface-2 text-[11px] font-medium text-text-main transition-colors cursor-pointer"
              >
                {testingMode === "free" ? "Testing Free..." : "Test Free"}
              </button>
              <button
                type="button"
                onClick={() => handleBatchTest("apikey")}
                disabled={testingMode === "apikey"}
                className="px-2.5 py-1 rounded-md border border-border bg-surface hover:bg-surface-2 text-[11px] font-medium text-text-main transition-colors cursor-pointer"
              >
                {testingMode === "apikey" ? "Testing Keys..." : "Test Keys"}
              </button>
            </div>
          </div>

          <AntTable
            columns={matrixColumns}
            dataSource={matrixRows}
            rowKey="key"
            size="small"
            bordered
            pagination={{ pageSize: 25, showSizeChanger: false }}
            scroll={{ x: 760 }}
            onRow={(record) => ({
              onClick: () => setDrawerProvider(record),
              style: { cursor: "pointer" },
            })}
          />
        </div>
      )}

      {Boolean(drawerProvider) && (
        <AntDrawer
          open
          onClose={() => setDrawerProvider(null)}
          title={drawerProvider.name}
          size="default"
          destroyOnHidden
        >
          <div className="space-y-4 font-mono text-xs">
            <div className="border border-border divide-y divide-border-subtle">
              <div className="flex justify-between px-3 py-2">
                <span className="text-text-muted">PROVIDER ID</span>
                <span className="text-text-main font-semibold">{drawerProvider.id}</span>
              </div>
              <div className="flex justify-between px-3 py-2">
                <span className="text-text-muted">AUTH TIER</span>
                <span>{drawerProvider.tier}</span>
              </div>
              <div className="flex justify-between px-3 py-2">
                <span className="text-text-muted">ACCOUNTS ACTIVE</span>
                <span className="text-text-main tabular-nums">
                  {drawerProvider.activeCount} / {drawerProvider.totalCount}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link href={`/dashboard/providers/${drawerProvider.id}`} prefetch={false} className="flex-1">
                <Button variant="primary" fullWidth icon="settings">
                  Manage Accounts & OAuth
                </Button>
              </Link>
              <Button
                variant="outline"
                disabled={drawerProvider.totalCount === 0 || testingMode === drawerProvider.id}
                onClick={() => handleBatchTest("provider", drawerProvider.id)}
              >
                {testingMode === drawerProvider.id ? "Testing..." : "Test"}
              </Button>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">
                REGISTERED CONNECTIONS ({drawerProvider.conns.length})
              </div>
              {drawerProvider.conns.length === 0 ? (
                <div className="p-4 border border-dashed border-border text-center text-text-muted">
                  No credentials configured yet. Click Manage Accounts above to connect.
                </div>
              ) : (
                <div className="border border-border divide-y divide-border-subtle">
                  {drawerProvider.conns.map((conn) => {
                    const isErr = conn.testStatus === "error" || conn.testStatus === "expired";
                    return (
                      <div key={conn.id} className="p-2.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-text-main truncate">
                            {conn.name || conn.email || conn.id}
                          </div>
                          <div className="text-[10px] text-text-muted uppercase">
                            {conn.authType || "oauth"} · {conn.testStatus || "untested"}
                          </div>
                        </div>
                        <span
                          className={`px-1.5 py-0.5 text-[10px] border rounded-md ${
                            isErr
                              ? "border-red-500/30 text-red-600 dark:text-red-400 bg-red-500/10"
                              : conn.isActive === false
                                ? "border-amber-500/30 text-amber-700 dark:text-amber-400 bg-amber-500/10"
                                : "border-[#a6c23f]/40 text-[#5c6f18] dark:text-[#a6c23f] bg-[#a6c23f]/10"
                          }`}
                        >
                          {isErr ? "ERR" : conn.isActive === false ? "PAUSED" : "OK"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </AntDrawer>
      )}

      {/* Connected Backends Strip (Cards view) */}
      {viewMode === "grid" && connectedProviderCount > 0 && (
        <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <span className="size-1.5 rounded-full bg-[#a6c23f]" />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Connected Backends
            </span>
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-1.5 min-w-0">
            {Array.from(new Set(connections.map((c) => c.provider))).map((provId) => {
              const provConns = connections.filter((c) => c.provider === provId);
              const active = provConns.filter((c) => c.isActive !== false).length;
              const hasErr = provConns.some((c) => c.testStatus === "error" || c.testStatus === "expired");
              const info = OAUTH_PROVIDERS[provId] || APIKEY_PROVIDERS[provId] || FREE_PROVIDERS[provId];
              return (
                <Link
                  key={provId}
                  href={`/dashboard/providers/${provId}`}
                  prefetch={false}
                  className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-alt px-2 py-1 text-xs hover:border-text-main transition-colors"
                >
                  <span
                    className={`size-1.5 ${
                      hasErr ? "bg-[#dc2626]" : active > 0 ? "bg-[#a6c23f]" : "bg-amber-500"
                    }`}
                  />
                  <span className="font-mono text-[11px] font-medium text-text-main">{info?.name || provId}</span>
                  <span className="border-l border-border pl-1.5 font-mono text-[10px] tabular-nums text-text-muted">
                    {active}/{provConns.length}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {!hasAnyResult && (
        <div className="text-center py-10 border border-dashed border-border rounded-lg bg-surface">
          <span className="material-symbols-outlined text-[28px] text-text-muted mb-2 block">
            search_off
          </span>
          <p className="font-mono text-text-muted text-xs uppercase tracking-wider">No providers match current filter</p>
        </div>
      )}

      {/* Custom Providers (OpenAI/Anthropic Compatible) — dynamic */}
      {viewMode === "grid" && showCompatibleSection && (
      <section className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2 bg-[#71717a]" />
            <h2 className="font-mono text-xs uppercase tracking-wider font-semibold flex items-center gap-2 leading-tight m-0 text-text-main">
              Custom Compatible Nodes
            </h2>
            <Tag variant="outlined" className="!m-0 !rounded-md !text-[11px]">
              {displayedCompatible.length}
            </Tag>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:flex sm:w-auto">
            <Button
              size="sm"
              variant="outline"
              icon="add"
              onClick={() => setShowAddAnthropicCompatibleModal(true)}
              className="w-full sm:w-auto"
            >
              Add Anthropic Compatible
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="add"
              onClick={() => setShowAddCompatibleModal(true)}
              className="w-full sm:w-auto"
            >
              Add OpenAI Compatible
            </Button>
          </div>
        </div>
        {displayedCompatible.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-4 border border-dashed border-border rounded-xl text-text-muted text-sm">
            <span className="material-symbols-outlined text-[18px]">extension</span>
            <span>No custom providers — use buttons above to add OpenAI/Anthropic compatible endpoints</span>
          </div>
        ) : (
          <div className={gridClass}>
            {displayedCompatible.map((info) => (
              <ApiKeyProviderCard
                key={info.id}
                providerId={info.id}
                provider={info}
                stats={getProviderStats(info.id, "apikey")}
                authType="compatible"
                compact={viewMode === "list"}
                onToggle={(active) =>
                  handleToggleProvider(info.id, "apikey", active)
                }
              />
            ))}
          </div>
        )}
      </section>
      )}

      {/* OAuth Providers */}
      {viewMode === "grid" && showOAuthSection && (
      <section className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-[#111111] dark:bg-[#fafafa]" />
            <h2 className="font-mono text-xs uppercase tracking-wider font-semibold flex items-center gap-2 leading-tight m-0 text-text-main">
              OAuth & Subscription Gateways
            </h2>
            <Tag variant="outlined" className="!m-0 !rounded-md !text-[11px]">
              {displayedOAuth.length}
            </Tag>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <button
              onClick={() => handleBatchTest("oauth")}
              disabled={!!testingMode}
              className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-1 font-mono text-[10px] uppercase transition-colors sm:w-auto ${
                testingMode === "oauth"
                  ? "bg-surface-2 border-text-main text-text-main"
                  : "bg-bg-alt border-border text-text-muted hover:text-text-main hover:border-text-main"
              }`}
              title="Test all OAuth connections"
              aria-label="Test all OAuth connections"
            >
              <span
                className={`material-symbols-outlined text-[14px]${testingMode === "oauth" ? " animate-spin" : ""}`}
              >
                play_arrow
              </span>
              {testingMode === "oauth" ? "Testing..." : "Test All OAuth"}
            </button>
          </div>
        </div>
        <div className={gridClass}>
          {displayedOAuth.map(([key, info]) => (
            <ProviderCard
              key={key}
              providerId={key}
              provider={info}
              stats={getProviderStats(key, "oauth")}
              authType="oauth"
              compact={viewMode === "list"}
              onToggle={(active) => handleToggleProvider(key, "oauth", active)}
            />
          ))}
        </div>
      </section>
      )}

      {/* Free Tier Providers */}
      {viewMode === "grid" && showFreeSection && (
      <section className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2 bg-emerald-500" />
            <h2 className="font-mono text-xs uppercase tracking-wider font-semibold flex items-center gap-2 leading-tight m-0 text-text-main">
              Free & Community Tiers
            </h2>
            <Tag variant="outlined" className="!m-0 !rounded-md !text-[11px]">
              {displayedFree.length + displayedFreeTier.length}
            </Tag>
          </div>
          <button
            onClick={() => handleBatchTest("free")}
            disabled={!!testingMode}
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-1 font-mono text-[10px] uppercase transition-colors sm:w-auto ${
              testingMode === "free"
                ? "bg-surface-2 border-text-main text-text-main"
                : "bg-bg-alt border-border text-text-muted hover:text-text-main hover:border-text-main"
            }`}
            title="Test all Free connections"
            aria-label="Test all Free provider connections"
          >
            <span
              className={`material-symbols-outlined text-[14px]${testingMode === "free" ? " animate-spin" : ""}`}
            >
              play_arrow
            </span>
            {testingMode === "free" ? "Testing..." : "Test All Free"}
          </button>
        </div>
        <div className={gridClass}>
          {displayedFree.map(([key, info]) => {
            const freeAuthTypes =
              key === "kiro" ? ["oauth", "apikey", "api_key"] : "oauth";
            return (
              <ProviderCard
                key={key}
                providerId={key}
                provider={info}
                stats={getProviderStats(key, freeAuthTypes)}
                authType="free"
                compact={viewMode === "list"}
                onToggle={(active) =>
                  handleToggleProvider(key, freeAuthTypes, active)
                }
              />
            );
          })}
          {displayedFreeTier.map(([key, info]) => (
            <ApiKeyProviderCard
              key={key}
              providerId={key}
              provider={info}
              stats={getProviderStats(key, "apikey")}
              authType="apikey"
              compact={viewMode === "list"}
              onToggle={(active) => handleToggleProvider(key, "apikey", active)}
            />
          ))}
        </div>
      </section>
      )}

      {/* API Key Providers — fixed list */}
      {viewMode === "grid" && showApikeySection && (
      <section className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-text-muted" />
            <h2 className="font-mono text-xs uppercase tracking-wider font-semibold flex items-center gap-2 leading-tight m-0 text-text-main">
              API Key Upstream Catalog
            </h2>
            <Tag variant="outlined" className="!m-0 !rounded-md !text-[11px]">
              {apikeyEntries.length}
            </Tag>
          </div>
          <button
            onClick={() => handleBatchTest("apikey")}
            disabled={!!testingMode}
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-1 font-mono text-[10px] uppercase transition-colors sm:w-auto ${
              testingMode === "apikey"
                ? "bg-surface-2 border-text-main text-text-main"
                : "bg-bg-alt border-border text-text-muted hover:text-text-main hover:border-text-main"
            }`}
            title="Test all API Key connections"
            aria-label="Test all API Key connections"
          >
            <span
              className={`material-symbols-outlined text-[14px]${testingMode === "apikey" ? " animate-spin" : ""}`}
            >
              play_arrow
            </span>
            {testingMode === "apikey" ? "Testing..." : "Test All API Keys"}
          </button>
        </div>
        <div className={gridClass}>
          {displayedApikey.map(([key, info]) => (
            <ApiKeyProviderCard
              key={key}
              providerId={key}
              provider={info}
              stats={getProviderStats(key, "apikey")}
              authType="apikey"
              compact={viewMode === "list"}
              onToggle={(active) => handleToggleProvider(key, "apikey", active)}
            />
          ))}
        </div>
        {!onlyConnected && !isApikeySearching && !showAllApikey && categoryFilter !== "apikey" && hiddenApikeyCount > 0 && (
          <button
            onClick={() => setShowAllApikey(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 font-mono text-xs uppercase text-text-muted transition-colors hover:border-text-main hover:text-text-main"
          >
            <span className="material-symbols-outlined text-[15px]">expand_more</span>
            Show all {apikeyEntries.length} API Key providers
          </button>
        )}
      </section>
      )}

      {/* Web Cookie Providers — use browser subscription cookie instead of API key */}
      {/* <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            Web Cookie Providers{" "}
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Object.entries(WEB_COOKIE_PROVIDERS).map(([key, info]) => (
            <ApiKeyProviderCard
              key={key}
              providerId={key}
              provider={info}
              stats={getProviderStats(key, "apikey")}
              authType="apikey"
              onToggle={(active) => handleToggleProvider(key, "apikey", active)}
            />
          ))}
        </div>
      </div> */}

      <AddCompatibleModal
        variant="openai"
        isOpen={showAddCompatibleModal}
        onClose={() => setShowAddCompatibleModal(false)}
        onCreated={(node) => {
          setProviderNodes((prev) => [...prev, node]);
          setShowAddCompatibleModal(false);
        }}
      />
      <AddCompatibleModal
        variant="anthropic"
        isOpen={showAddAnthropicCompatibleModal}
        onClose={() => setShowAddAnthropicCompatibleModal(false)}
        onCreated={(node) => {
          setProviderNodes((prev) => [...prev, node]);
          setShowAddAnthropicCompatibleModal(false);
        }}
      />

      {/* Test Results Modal */}
      {testResults && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[6vh] sm:pt-[10vh]"
          onClick={() => setTestResults(null)}
        >
          <div className="absolute inset-0 bg-black/70" />
          <div
            className="relative bg-surface border border-border rounded-lg w-full max-w-[600px] max-h-[86vh] sm:max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg-alt">
              <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-main">Test Results</h3>
              <button
                onClick={() => setTestResults(null)}
                className="p-1 rounded-lg border border-border hover:border-text-main text-text-muted hover:text-text-main transition-colors"
                aria-label="Close test results"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>
            <div className="p-4">
              <ProviderTestResultsView results={testResults} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderCard({ providerId, provider, stats, authType, compact = false, onToggle }) {
  const { connected, error, errorCode, errorTime, allDisabled, total } = stats;
  const isNoAuth = !!provider.noAuth;
  const accentColor = provider.color || "#f59e0b";

  return (
    <Link href={`/dashboard/providers/${providerId}`} prefetch={false} className="group min-w-0">
      <Card
        padding="xs"
        hover
        className={`h-full relative ${
          connected > 0 && !allDisabled ? "border-text-main/30" : ""
        } ${allDisabled ? "opacity-55" : ""}`}
      >
        <div className={`flex min-w-0 items-center justify-between gap-3 ${compact ? "py-0.5" : "py-1"}`}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="size-9 shrink-0 rounded-lg border border-border bg-bg-alt flex items-center justify-center"
            >
              <ProviderIcon
                src={`/providers/${provider.id}.png`}
                alt={provider.name}
                size={24}
                className="object-contain max-w-[24px] max-h-[24px]"
                fallbackText={
                  provider.textIcon || provider.id.slice(0, 2).toUpperCase()
                }
                fallbackColor={provider.color}
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <h3 className="truncate font-mono font-semibold text-xs text-text-main group-hover:underline transition-colors">
                  {provider.name}
                </h3>
                {total > 0 && (
                  <span className="shrink-0 font-mono text-[10px] px-1 border border-border bg-bg-alt text-text-muted tabular-nums">
                    {total}
                  </span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-xs flex-wrap mt-1">
                {allDisabled ? (
                  <Badge variant="default" size="sm">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">
                        pause_circle
                      </span>
                      Disabled
                    </span>
                  </Badge>
                ) : isNoAuth ? (
                  <Badge variant="success" size="sm" dot>Ready</Badge>
                ) : (
                  <>
                    {getStatusDisplay(connected, error, errorCode)}
                    {errorTime && (
                      <span className="text-[11px] font-mono text-text-muted">{errorTime}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {stats.total > 0 && (
              <div
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle(!allDisabled ? false : true);
                }}
              >
                <Toggle
                  size="sm"
                  checked={!allDisabled}
                  onChange={() => {}}
                  title={allDisabled ? "Enable provider" : "Disable provider"}
                />
              </div>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}

ProviderCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  provider: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    textIcon: PropTypes.string,
  }).isRequired,
  stats: PropTypes.shape({
    connected: PropTypes.number,
    error: PropTypes.number,
    errorCode: PropTypes.string,
    errorTime: PropTypes.string,
  }).isRequired,
  authType: PropTypes.string,
  compact: PropTypes.bool,
  onToggle: PropTypes.func,
};

function ApiKeyProviderCard({
  providerId,
  provider,
  stats,
  authType,
  compact = false,
  onToggle,
}) {
  const { connected, error, errorCode, errorTime, allDisabled, total } = stats;
  const isCompatible = providerId.startsWith(OPENAI_COMPATIBLE_PREFIX);
  const isAnthropicCompatible = providerId.startsWith(
    ANTHROPIC_COMPATIBLE_PREFIX,
  );
  const accentColor = provider.color || "#06b6d4";

  const getIconPath = () => {
    if (isCompatible)
      return provider.apiType === "responses"
        ? "/providers/oai-r.png"
        : "/providers/oai-cc.png";
    if (isAnthropicCompatible) return "/providers/anthropic-m.png";
    return `/providers/${provider.id}.png`;
  };

  return (
    <Link href={`/dashboard/providers/${providerId}`} prefetch={false} className="group min-w-0">
      <Card
        padding="xs"
        hover
        className={`h-full relative ${
          connected > 0 && !allDisabled ? "border-text-main/30" : ""
        } ${allDisabled ? "opacity-55" : ""}`}
      >
        <div className={`flex min-w-0 items-center justify-between gap-3 ${compact ? "py-0.5" : "py-1"}`}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="size-9 shrink-0 rounded-lg border border-border bg-bg-alt flex items-center justify-center"
            >
              <ProviderIcon
                src={getIconPath()}
                alt={provider.name}
                size={24}
                className="object-contain max-w-[24px] max-h-[24px]"
                fallbackText={
                  provider.textIcon || provider.id.slice(0, 2).toUpperCase()
                }
                fallbackColor={provider.color}
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <h3 className="truncate font-mono font-semibold text-xs text-text-main group-hover:underline transition-colors">
                  {provider.name}
                </h3>
                {total > 0 && (
                  <span className="shrink-0 font-mono text-[10px] px-1 border border-border bg-bg-alt text-text-muted tabular-nums">
                    {total}
                  </span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-xs flex-wrap mt-1">
                {allDisabled ? (
                  <Badge variant="default" size="sm">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">
                        pause_circle
                      </span>
                      Disabled
                    </span>
                  </Badge>
                ) : (
                  <>
                    {getStatusDisplay(connected, error, errorCode)}
                    {isCompatible && (
                      <Badge variant="info" size="sm">
                        {provider.apiType === "responses"
                          ? "Responses"
                          : "Chat"}
                      </Badge>
                    )}
                    {isAnthropicCompatible && (
                      <Badge variant="purple" size="sm">
                        Messages
                      </Badge>
                    )}
                    {errorTime && (
                      <span className="text-[11px] font-mono text-text-muted">{errorTime}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {stats.total > 0 && (
              <div
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle(!allDisabled ? false : true);
                }}
              >
                <Toggle
                  size="sm"
                  checked={!allDisabled}
                  onChange={() => {}}
                  title={allDisabled ? "Enable provider" : "Disable provider"}
                />
              </div>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}

ApiKeyProviderCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  provider: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    textIcon: PropTypes.string,
    apiType: PropTypes.string,
  }).isRequired,
  stats: PropTypes.shape({
    connected: PropTypes.number,
    error: PropTypes.number,
    errorCode: PropTypes.string,
    errorTime: PropTypes.string,
  }).isRequired,
  authType: PropTypes.string,
  onToggle: PropTypes.func,
};

function ProviderTestResultsView({ results }) {
  if (results.error && !results.results) {
    return (
      <div className="text-center py-6">
        <span className="material-symbols-outlined text-red-500 text-[32px] mb-2 block">
          error
        </span>
        <p className="text-sm text-red-400">{results.error}</p>
      </div>
    );
  }

  const { summary, mode } = results;
  const items = results.results || [];
  const modeLabel =
    {
      oauth: "OAuth",
      free: "Free",
      apikey: "API Key",
      provider: "Provider",
      all: "All",
    }[mode] || mode;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {summary && (
        <div className="flex flex-wrap items-center gap-2 text-xs mb-1 sm:gap-3">
          <span className="text-text-muted">{modeLabel} Test</span>
          <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">
            {summary.passed} passed
          </span>
          {summary.failed > 0 && (
            <span className="px-2 py-0.5 rounded bg-red-500/15 text-red-400 font-medium">
              {summary.failed} failed
            </span>
          )}
          <span className="text-text-muted sm:ml-auto">
            {summary.total} tested
          </span>
        </div>
      )}
      {items.map((r, i) => (
        <div
          key={r.connectionId || i}
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-alt px-3 py-2 text-xs sm:flex-nowrap"
        >
          <span
            className={`material-symbols-outlined text-[16px] ${r.valid ? "text-emerald-500" : "text-red-500"}`}
          >
            {r.valid ? "check_circle" : "error"}
          </span>
          <div className="min-w-0 flex-[1_1_160px]">
            <span className="block truncate font-medium sm:inline">
              {r.connectionName}
            </span>
            <span className="block truncate text-text-muted sm:ml-1.5 sm:inline">
              ({r.provider})
            </span>
          </div>
          {r.latencyMs !== undefined && (
            <span className="shrink-0 text-text-muted font-mono tabular-nums">
              {r.latencyMs}ms
            </span>
          )}
          <span
            className={`shrink-0 text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
              r.valid
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-red-500/15 text-red-400"
            }`}
          >
            {r.valid ? "OK" : r.diagnosis?.type || "ERROR"}
          </span>
        </div>
      ))}
      {items.length === 0 && (
        <div className="text-center py-4 text-text-muted text-sm">
          No active connections found for this group.
        </div>
      )}
    </div>
  );
}

ProviderTestResultsView.propTypes = {
  results: PropTypes.shape({
    mode: PropTypes.string,
    results: PropTypes.array,
    summary: PropTypes.shape({
      total: PropTypes.number,
      passed: PropTypes.number,
      failed: PropTypes.number,
    }),
    error: PropTypes.string,
  }).isRequired,
};
