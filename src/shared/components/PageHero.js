"use client";

import { Card, Tag, Statistic } from "antd";
import { cn } from "@/shared/utils/cn";

export default function PageHero({
  eyebrow,
  title,
  description,
  icon = "hub",
  badge,
  stats = [],
  actions,
  toolbar,
  className,
  children,
}) {
  return (
    <Card
      variant="borderless"
      className={cn("hyperion-card aurora-border stagger-in !bg-surface/90 backdrop-blur-xl", className)}
      styles={{ body: { padding: "20px 22px" } }}
    >
      <div className="relative z-10 flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="size-11 rounded-xl bg-gradient-to-br from-amber-500/20 via-amber-500/10 to-cyan-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 shadow-[0_0_20px_rgba(245,158,11,0.14)]">
              {typeof icon === "string" ? (
                <span className="material-symbols-outlined text-[22px] text-amber-400">
                  {icon}
                </span>
              ) : (
                icon
              )}
            </div>
            <div className="flex flex-col gap-1 min-w-0">
              {(eyebrow || badge) && (
                <div className="flex flex-wrap items-center gap-2">
                  {eyebrow && (
                    <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-amber-400/90 font-semibold">
                      {eyebrow}
                    </span>
                  )}
                  {badge?.text && (
                    <Tag
                      color={badge.color || "gold"}
                      variant="filled"
                      className="!m-0 !rounded-full !text-[10px] !font-mono !px-2"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {badge.dot !== false && (
                          <span className="beacon-dot size-1.5 rounded-full bg-current" />
                        )}
                        {badge.text}
                      </span>
                    </Tag>
                  )}
                </div>
              )}
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-text-main m-0 truncate">
                {title}
              </h1>
              {description && (
                <p className="text-xs sm:text-sm text-text-muted m-0 max-w-2xl">
                  {description}
                </p>
              )}
            </div>
          </div>

          {actions && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {actions}
            </div>
          )}
        </div>

        {stats.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {stats.map((item, idx) => (
              <div
                key={item.label || idx}
                className="rounded-xl border border-border/80 bg-surface-2/65 px-3.5 py-2.5 hover:border-amber-500/35 transition-colors"
              >
                <Statistic
                  title={
                    <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
                      {item.label}
                    </span>
                  }
                  value={item.value}
                  styles={{
                    content: {
                      color: item.color || "#f59e0b",
                      fontSize: "20px",
                      fontWeight: 700,
                      fontFamily: "var(--font-jetbrains-mono), monospace",
                    },
                  }}
                  suffix={
                    item.suffix ? (
                      <span className="text-[11px] font-mono text-text-muted ml-1">
                        {item.suffix}
                      </span>
                    ) : undefined
                  }
                />
              </div>
            ))}
          </div>
        )}

        {toolbar && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-border/60">
            {toolbar}
          </div>
        )}

        {children}
      </div>
    </Card>
  );
}
