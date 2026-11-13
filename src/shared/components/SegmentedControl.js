"use client";

import { Segmented } from "antd";
import { cn } from "@/shared/utils/cn";

const SIZE_MAP = {
  sm: "small",
  md: "medium",
  lg: "large",
};

export default function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "md",
  className,
}) {
  const mappedOptions = options.map((option) => ({
    value: option.value,
    disabled: option.disabled,
    label: (
      <span className="inline-flex items-center gap-1.5">
        {option.icon && (
          <span className="material-symbols-outlined text-[15px] leading-none">
            {option.icon}
          </span>
        )}
        <span>{option.label}</span>
      </span>
    ),
  }));

  return (
    <Segmented
      options={mappedOptions}
      value={value}
      onChange={(nextVal) => onChange?.(nextVal)}
      size={SIZE_MAP[size] || "medium"}
      className={cn("hyperion-segmented !bg-surface-2/90 !border !border-border/70", className)}
    />
  );
}
