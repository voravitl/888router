"use client";

import { Select as AntSelect } from "antd";
import { cn } from "@/shared/utils/cn";

export default function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder = "Select an option",
  error,
  hint,
  disabled = false,
  required = false,
  className,
  selectClassName,
  ...props
}) {
  const hasEmptyOption = options.some((opt) => opt.value === "");
  const normalizedValue =
    value === "" && !hasEmptyOption ? undefined : value;

  const handleChange = (nextValue) => {
    if (!onChange) return;
    onChange({ target: { value: nextValue ?? "" } });
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="text-sm font-medium text-text-main">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      <AntSelect
        value={normalizedValue}
        onChange={handleChange}
        disabled={disabled}
        placeholder={placeholder}
        status={error ? "error" : undefined}
        size="large"
        options={options.map((opt) => ({
          value: opt.value,
          label: opt.label,
          disabled: opt.disabled,
        }))}
        suffix={
          <span className="material-symbols-outlined text-[18px] text-text-muted">
            expand_more
          </span>
        }
        className={cn("w-full mono-select !rounded-lg", selectClassName)}
        {...props}
      />
      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-xs text-text-muted">{hint}</p>
      )}
    </div>
  );
}
