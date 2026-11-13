"use client";

import { Tag } from "antd";
import { cn } from "@/shared/utils/cn";

const variantColors = {
  default: "default",
  primary: "default",
  success: "green",
  warning: "gold",
  error: "red",
  info: "default",
  purple: "default",
};

const variantClasses = {
  default: "!bg-surface-2 !text-text-muted !border-border",
  primary: "!bg-text-main !text-surface !border-text-main",
  success: "!bg-[#a6c23f]/14 !text-[#3f5209] dark:!text-[#c4df64] !border-[#a6c23f]/40",
  warning: "!bg-amber-500/10 !text-amber-700 dark:!text-amber-400 !border-amber-500/30",
  error: "!bg-red-500/10 !text-red-700 dark:!text-red-400 !border-red-500/30",
  info: "!bg-surface-2 !text-text-main !border-border",
  purple: "!bg-surface-2 !text-text-muted !border-border",
};

const dotColors = {
  default: "bg-neutral-400",
  primary: "bg-[#a6c23f]",
  success: "bg-[#a6c23f]",
  warning: "bg-amber-500",
  error: "bg-red-500",
  info: "bg-neutral-500",
  purple: "bg-neutral-500",
};

const sizes = {
  sm: "!px-2 !py-0 !text-[11px] !leading-[20px]",
  md: "!px-2.5 !py-0.5 !text-xs !leading-[20px]",
  lg: "!px-3 !py-1 !text-xs",
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
      variant="outlined"
      className={cn(
        "!m-0 !inline-flex items-center gap-1.5 !rounded-md !font-medium transition-colors",
        variantClasses[variant] || variantClasses.default,
        sizes[size] || sizes.md,
        className
      )}
    >
      {dot && (
        <span
          className={cn(
            "inline-block size-1.5 rounded-full shrink-0",
            dotColors[variant] || dotColors.default
          )}
        />
      )}
      {icon && <span className="material-symbols-outlined text-[13px] leading-none">{icon}</span>}
      {children}
    </Tag>
  );
}
