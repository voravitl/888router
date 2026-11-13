"use client";

import { Input as AntInput } from "antd";
import { cn } from "@/shared/utils/cn";

export default function Input({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  icon,
  disabled = false,
  required = false,
  className,
  inputClassName,
  ...props
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="text-sm font-medium text-text-main">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      <AntInput
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        disabled={disabled}
        status={error ? "error" : undefined}
        size="large"
        prefix={
          icon ? (
            <span className="material-symbols-outlined text-[18px] text-text-muted mr-1">
              {icon}
            </span>
          ) : undefined
        }
        className={cn(
          "!rounded-[10px] !text-[16px] sm:!text-sm !bg-surface-2/85 !border-border/80 hover:!border-amber-500/45 focus-within:!border-amber-500 focus-within:!shadow-[0_0_0_2px_rgba(245,158,11,0.16)] transition-all duration-150",
          error && "!border-red-500/70 focus-within:!shadow-[0_0_0_2px_rgba(239,68,68,0.2)]",
          inputClassName
        )}
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
