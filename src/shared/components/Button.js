"use client";

import { Button as AntButton } from "antd";
import { cn } from "@/shared/utils/cn";

const VARIANT_MAP = {
  primary: { type: "primary" },
  secondary: { color: "default", variant: "filled" },
  outline: { color: "default", variant: "outlined" },
  ghost: { color: "default", variant: "text" },
  danger: { color: "danger", variant: "solid" },
  success: { color: "green", variant: "solid" },
};

const SIZE_MAP = {
  sm: "small",
  md: "medium",
  lg: "large",
};

function renderIcon(icon) {
  if (!icon) return undefined;
  if (typeof icon === "string") {
    return <span className="material-symbols-outlined text-[18px] leading-none">{icon}</span>;
  }
  return icon;
}

export default function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  disabled = false,
  loading = false,
  fullWidth = false,
  className,
  type,
  htmlType,
  ...props
}) {
  const antStyle = VARIANT_MAP[variant] || VARIANT_MAP.primary;
  const resolvedHtmlType = htmlType || (type === "submit" || type === "reset" ? type : "button");

  return (
    <AntButton
      {...antStyle}
      size={SIZE_MAP[size] || "medium"}
      disabled={disabled}
      loading={loading}
      block={fullWidth}
      htmlType={resolvedHtmlType}
      icon={renderIcon(icon)}
      className={cn(
        "!inline-flex !items-center !justify-center !gap-2 !font-semibold active:scale-[0.98] transition-all",
        variant === "primary" && "!shadow-[0_6px_18px_-6px_rgba(245,158,11,0.55)]",
        variant === "success" && "!bg-emerald-600 hover:!bg-emerald-500 !border-emerald-500 !text-white",
        className
      )}
      {...props}
    >
      {children}
      {iconRight && !loading ? renderIcon(iconRight) : null}
    </AntButton>
  );
}
