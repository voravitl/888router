"use client";

import FreeBudgetCard from "../usage/components/FreeBudgetCard";

export default function FreeTiersPage() {
  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-text-main">Free Tiers & Zero-Cost Models</h1>
        <p className="text-xs text-text-muted">
          Real-time catalog of 42+ providers and 495+ models with documented free monthly token allowances, uncapped tiers, and privacy guarantees.
        </p>
      </div>

      <FreeBudgetCard />
    </div>
  );
}
