"use client";

import { cn } from "@/shared/utils/cn";

export default function Card({
  children,
  title,
  subtitle,
  icon,
  action,
  padding = "md",
  hover = false,
  elev = false,
  aurora = false,
  className,
  ...props
}) {
  const paddings = {
    none: "",
    xs: "p-3.5",
    sm: "p-4",
    md: "p-5",
    lg: "p-6",
  };

  return (
    <div
      className={cn(
        "bg-surface border border-border rounded-xl text-text-main shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:shadow-none transition-colors",
        aurora && "border-border",
        elev && "bg-bg-alt",
        hover && "hover:border-text-subtle cursor-pointer",
        paddings[padding],
        className
      )}
      {...props}
    >
      {(title || action) && (
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-border-subtle gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {icon && (
              <div className="size-8 rounded-lg border border-border-subtle bg-surface-2 text-text-main flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-[18px]">{icon}</span>
              </div>
            )}
            <div className="min-w-0">
              {title && (
                <h3 className="text-sm font-semibold tracking-[-0.015em] text-text-main truncate">{title}</h3>
              )}
              {subtitle && (
                <p className="text-xs text-text-muted truncate">{subtitle}</p>
              )}
            </div>
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

Card.Section = function CardSection({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "p-3.5 rounded-lg bg-bg-alt border border-border-subtle",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.Row = function CardRow({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "py-2.5 px-3 -mx-3 transition-colors rounded-lg",
        "border-b border-border-subtle last:border-b-0",
        "hover:bg-surface-2/60",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.ListItem = function CardListItem({
  children,
  actions,
  className,
  ...props
}) {
  return (
    <div
      className={cn(
        "group flex items-center justify-between py-2.5 px-3 -mx-3 rounded-lg",
        "border-b border-border-subtle last:border-b-0",
        "hover:bg-surface-2/60 transition-colors",
        className
      )}
      {...props}
    >
      <div className="flex-1 min-w-0">{children}</div>
      {actions && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  );
};
