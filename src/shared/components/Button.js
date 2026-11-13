"use client";

import { Button as AntButton } from "antd";
import { cn } from "@/shared/utils/cn";

const VARIANT_MAP = {
  primary: { type: "primary" },
  secondary: { color: "default", variant: "filled" },
  outline: { color: "default", variant: "outlined" },
  ghost: { color: "default", variant: "text" },
  danger: { color: "danger", variant: "outlined" },
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
    return <span className="material-symbols-outlined text-[17px] leading-none">{icon}</span>;
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
        "!inline-flex !items-center !justify-center !gap-2 !rounded-lg !text-[13px] !font-medium !shadow-none transition-colors",
        variant === "primary" && "!bg-[#111111] !text-white hover:!bg-[#262626] dark:!bg-[#fafafa] dark:!text-[#111111] dark:hover:!bg-[#e4e4e7] !border-transparent",
        variant === "outline" && "!border-border !bg-surface !text-text-main hover:!bg-surface-2",
        variant === "secondary" && "!bg-surface-2 !text-text-main hover:!bg-surface-3",
        variant === "success" && "!bg-[#16a34a] hover:!bg-[#15803d] !border-transparent !text-white",
        className
      )}
      {...props}
    >
      {children}
      {iconRight && !loading ? renderIcon(iconRight) : null}
    </AntButton>
  );
}
