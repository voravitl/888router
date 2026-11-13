"use client";

import { cn } from "@/shared/utils/cn";

export default function PageHero({
  title,
  description,
  icon,
  badge,
  stats = [],
  actions,
  toolbar,
  className,
  children,
}) {
  const badgeText = badge?.text || badge?.label;

  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-surface text-text-main shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:shadow-none",
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-start sm:items-center gap-3.5 min-w-0">
          {icon && (
            <div className="size-9 rounded-lg border border-border-subtle bg-surface-2 flex items-center justify-center shrink-0 text-text-main">
              <span className="material-symbols-outlined text-[19px]">
                {typeof icon === "string" ? icon : "tune"}
              </span>
            </div>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-lg sm:text-xl font-semibold tracking-[-0.025em] text-text-main m-0">
                {title}
              </h1>
              {badgeText && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-text-muted">
                  <span className="size-1.5 rounded-full bg-[#a6c23f]" aria-hidden="true" />
                  {badgeText}
                </span>
              )}
            </div>
            {description && (
              <p className="text-xs sm:text-sm text-text-muted mt-0.5 line-clamp-1">
                {description}
              </p>
            )}
          </div>
        </div>

        {actions && (
          <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">{actions}</div>
        )}
      </div>

      {stats.length > 0 && (
        <div
          className={cn(
            "grid grid-cols-2 lg:grid-cols-4 border-t border-border-subtle divide-x divide-y lg:divide-y-0 divide-border-subtle bg-bg-alt/60",
            !toolbar && !children && "rounded-b-xl"
          )}
        >
          {stats.map((item, idx) => (
            <div key={item.label || idx} className="px-5 py-3 flex flex-col gap-0.5 min-w-0">
              <span className="text-[11px] font-medium text-text-muted truncate">
                {item.label}
              </span>
              <div className="flex items-baseline gap-1.5">
                <span
                  className="text-base sm:text-lg font-semibold tracking-tight tabular-nums text-text-main"
                  style={item.color ? { color: item.color } : undefined}
                >
                  {item.value}
                </span>
                {item.suffix ? (
                  <span className="text-xs text-text-muted">{item.suffix}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {toolbar && (
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-border-subtle bg-bg-alt/50 min-w-0",
            !children && "rounded-b-xl"
          )}
        >
          {toolbar}
        </div>
      )}

      {children && <div className="border-t border-border-subtle">{children}</div>}
    </section>
  );
}
