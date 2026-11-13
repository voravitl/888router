"use client";

import { useEffect } from "react";
import { cn } from "@/shared/utils/cn";

export default function Drawer({
  isOpen,
  onClose,
  title,
  children,
  width = "md",
  className,
}) {
  const widths = {
    sm: "w-[400px] max-w-full",
    md: "w-[520px] max-w-full",
    lg: "w-[640px] max-w-full",
    xl: "w-[820px] max-w-full",
    full: "w-full",
  };

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/40 fade-in cursor-pointer"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        className={cn(
          "absolute right-0 top-0 h-full bg-surface flex flex-col slide-in-right border-l border-border shadow-xl",
          widths[width] || widths.md,
          className
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          {title && (
            <h2 className="text-base font-semibold tracking-[-0.015em] text-text-main m-0">
              {title}
            </h2>
          )}
          <button
            type="button"
            onClick={onClose}
            className="size-8 rounded-lg border border-border bg-bg-alt text-text-muted hover:text-text-main hover:bg-surface-2 flex items-center justify-center transition-colors"
            aria-label="Close drawer"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">{children}</div>
      </div>
    </div>
  );
}
