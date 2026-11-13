"use client";

import { useState } from "react";
import { Button, Tag } from "antd";
import { ReloadOutlined, InfoCircleOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaProgressBar from "./QuotaProgressBar";
import { calculatePercentage } from "./utils";

export default function ProviderLimitCard({
  provider,
  name,
  plan,
  quotas = [],
  message = null,
  loading = false,
  error = null,
  onRefresh,
}) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card padding="md" className="flex flex-col gap-4 border border-border bg-surface">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-9 rounded-lg border border-border bg-bg-alt flex items-center justify-center p-1.5 shrink-0">
            <ProviderIcon
              src={`/providers/${provider}.png`}
              alt={provider || "Provider"}
              size={28}
              className="object-contain rounded"
              fallbackText={provider?.slice(0, 2).toUpperCase() || "PR"}
            />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-sm text-text-main truncate m-0">
              {name || provider}
            </h3>
            {plan && <Tag className="mt-1 m-0 uppercase text-[10px]">{plan}</Tag>}
          </div>
        </div>

        <Button
          size="small"
          icon={<ReloadOutlined spin={refreshing || loading} />}
          disabled={refreshing || loading}
          onClick={handleRefresh}
          title="Refresh quota"
        />
      </div>

      {loading && (
        <div className="space-y-3">
          <div className="h-4 bg-bg-alt rounded animate-pulse" />
          <div className="h-2 bg-bg-alt rounded animate-pulse" />
        </div>
      )}

      {!loading && error && (
        <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
          <ExclamationCircleOutlined className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && message && (
        <div className="p-3 rounded-lg border border-border bg-bg-alt flex items-start gap-2 text-xs text-text-muted">
          <InfoCircleOutlined className="mt-0.5 shrink-0" />
          <span>{message}</span>
        </div>
      )}

      {!loading && !error && !message && quotas?.length > 0 && (
        <div className="space-y-3">
          {quotas.map((quota, index) => {
            const percentage = quota.unlimited ? 100 : calculatePercentage(quota.used, quota.total);
            return (
              <QuotaProgressBar
                key={index}
                label={quota.name}
                percentage={percentage}
                used={quota.used}
                total={quota.total}
                unlimited={quota.unlimited}
                resetTime={quota.resetAt}
                recurring={quota.recurring !== false}
              />
            );
          })}
        </div>
      )}

      {!loading && !error && !message && (!quotas || quotas.length === 0) && (
        <div className="text-center py-6 text-xs text-text-muted">No quota data available</div>
      )}
    </Card>
  );
}
