"use client";

import { Tag } from "antd";
import { cn } from "@/shared/utils/cn";

const variantColors = {
  default: "default",
  primary: "gold",
  success: "green",
  warning: "orange",
  error: "red",
  info: "cyan",
  purple: "purple",
};

const variantClasses = {
  default: "bg-surface-2/80 text-text-muted border-border/80",
  primary: "bg-amber-500/12 text-amber-300 border-amber-500/30",
  success: "bg-emerald-500/12 text-emerald-300 border-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-200 border-amber-400/35",
  error: "bg-red-500/12 text-red-300 border-red-500/30",
  info: "bg-cyan-500/12 text-cyan-300 border-cyan-500/30",
  purple: "bg-purple-500/12 text-purple-300 border-purple-500/30",
};

const dotColors = {
  default: "bg-zinc-400",
  primary: "bg-amber-400",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  error: "bg-red-400",
  info: "bg-cyan-400",
  purple: "bg-purple-400",
};

const sizes = {
  sm: "px-2 py-0.5 text-[10px]",
  md: "px-2.5 py-0.5 text-xs",
  lg: "px-3 py-1 text-sm",
};

export default function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  icon,
  className,
}) {
  return (
    <Tag
      color={variantColors[variant] || "default"}
      variant="filled"
      className={cn(
        "!m-0 inline-flex items-center gap-1.5 rounded-full font-semibold border transition-all duration-200",
        variantClasses[variant] || variantClasses.default,
        sizes[size] || sizes.md,
        className
      )}
    >
      {dot && (
        <span
          className={cn(
            "beacon-dot size-1.5 rounded-full shrink-0",
            dotColors[variant] || dotColors.default
          )}
        />
      )}
      {icon && <span className="material-symbols-outlined text-[14px] leading-none">{icon}</span>}
      {children}
    </Tag>
  );
}
