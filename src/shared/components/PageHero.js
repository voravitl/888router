"use client";

import { Card, Tag, Statistic } from "antd";
import { cn } from "@/shared/utils/cn";

const ACCENT_THEMES = {
  amber: {
    iconBox: "from-amber-500/25 via-amber-500/10 to-cyan-500/20 border-amber-500/35 shadow-[0_0_24px_rgba(245,158,11,0.18)] text-amber-400",
    eyebrow: "text-amber-400/90",
    glow: "radial-gradient(circle at 10% 10%, rgba(245,158,11,0.14), transparent 55%)",
  },
  cyan: {
    iconBox: "from-cyan-500/25 via-sky-500/10 to-indigo-500/20 border-cyan-500/35 shadow-[0_0_24px_rgba(6,182,212,0.2)] text-cyan-400",
    eyebrow: "text-cyan-400/90",
    glow: "radial-gradient(circle at 10% 10%, rgba(6,182,212,0.16), transparent 55%)",
  },
  emerald: {
    iconBox: "from-emerald-500/25 via-teal-500/10 to-cyan-500/20 border-emerald-500/35 shadow-[0_0_24px_rgba(16,185,129,0.2)] text-emerald-400",
    eyebrow: "text-emerald-400/90",
    glow: "radial-gradient(circle at 10% 10%, rgba(16,185,129,0.16), transparent 55%)",
  },
  violet: {
    iconBox: "from-violet-500/25 via-fuchsia-500/10 to-cyan-500/20 border-violet-500/35 shadow-[0_0_24px_rgba(168,85,247,0.2)] text-violet-400",
    eyebrow: "text-violet-400/90",
    glow: "radial-gradient(circle at 10% 10%, rgba(168,85,247,0.16), transparent 55%)",
  },
};

export default function PageHero({
  eyebrow,
  title,
  description,
  icon = "hub",
  accent = "amber",
  badge,
  stats = [],
  actions,
  toolbar,
  className,
  children,
}) {
  const theme = ACCENT_THEMES[accent] || ACCENT_THEMES.amber;
  const badgeText = badge?.text || badge?.label;
  const showDot = badge?.dot ?? badge?.pulse ?? true;

  return (
    <Card
      variant="borderless"
      className={cn("hyperion-card aurora-border stagger-in !bg-surface/90 backdrop-blur-xl", className)}
      styles={{ body: { padding: "20px 22px", backgroundImage: theme.glow } }}
    >
      <div className="relative z-10 flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className={cn("size-11 rounded-xl bg-gradient-to-br border flex items-center justify-center shrink-0 text-xl", theme.iconBox)}>
              {typeof icon === "string" ? (
                <span className="material-symbols-outlined text-[22px]">
                  {icon}
                </span>
              ) : (
                icon
              )}
            </div>
            <div className="flex flex-col gap-1 min-w-0">
              {(eyebrow || badgeText) && (
                <div className="flex flex-wrap items-center gap-2">
                  {eyebrow && (
                    <span className={cn("text-[11px] font-mono uppercase tracking-[0.18em] font-semibold", theme.eyebrow)}>
                      {eyebrow}
                    </span>
                  )}
                  {badgeText && (
                    <Tag
                      color={badge.color || "gold"}
                      variant="filled"
                      className="!m-0 !rounded-full !text-[10px] !font-mono !px-2.5"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {showDot && (
                          <span className="beacon-dot size-1.5 rounded-full bg-current" />
                        )}
                        {badgeText}
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
