"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import Button from "./Button";
import { ConfirmModal } from "./Modal";

const VISIBLE_MEDIA_KINDS = ["embedding", "image", "tts", "stt"];
const COMBINED_WEB_ITEM = {
  id: "web",
  label: "Web Fetch & Search",
  icon: "travel_explore",
  href: "/dashboard/media-providers/web",
};

const TELEMETRY_ITEMS = [
  { code: "01", href: "/dashboard/usage", label: "Usage & Traces", icon: "analytics" },
  { code: "02", href: "/dashboard/endpoint", label: "Gateway & Keys", icon: "api" },
  { code: "03", href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { code: "04", href: "/dashboard/token-saver", label: "Token Savings", icon: "compress" },
];

const ROUTING_ITEMS = [
  { code: "05", href: "/dashboard/providers", label: "Providers", icon: "dns" },
  { code: "06", href: "/dashboard/combos", label: "Combos", icon: "layers" },
  { code: "07", href: "/dashboard/basic-chat", label: "Test Chat", icon: "chat" },
  { code: "08", href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
];

const SYSTEM_ITEMS = [
  { code: "10", href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { code: "11", href: "/dashboard/skills", label: "Skills", icon: "extension" },
  { code: "12", href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
  { code: "13", href: "/dashboard/translator", label: "Translator", icon: "translate", requiresTranslator: true },
  { code: "14", href: "/dashboard/profile", label: "Settings", icon: "settings" },
];

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [mediaOpen, setMediaOpen] = useState(() => pathname?.startsWith("/dashboard/media-providers") || false);
  const [collapsed, setCollapsed] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        if (data.enableTranslator) setEnableTranslator(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/version")
      .then((res) => res.json())
      .then((data) => {
        if (data.hasUpdate) setUpdateInfo(data);
      })
      .catch(() => {});
  }, []);

  const isActive = (href) => {
    if (href === "/dashboard/endpoint") {
      return pathname === "/dashboard" || pathname.startsWith("/dashboard/endpoint");
    }
    return pathname.startsWith(href);
  };

  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  const handleCopyAndShutdown = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
    } catch {
      /* clipboard blocked */
    }
    copy(INSTALL_CMD);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setShutdownCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setShutdownCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  const isCompact = collapsed && !onClose;

  const renderLink = (item) => {
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        prefetch={false}
        onClick={onClose}
        title={item.label}
        className={cn(
          "flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border transition-colors",
          isCompact && "justify-center px-0",
          active
            ? "border-border-subtle bg-surface-2 text-text-main font-medium"
            : "border-transparent text-text-muted hover:text-text-main hover:bg-surface-2/60"
        )}
      >
        <span className={cn("material-symbols-outlined text-[17px] shrink-0", active ? "text-text-main" : "text-text-muted")}>
          {item.icon}
        </span>
        {!isCompact && (
          <span className="text-[13px] font-medium truncate">{item.label}</span>
        )}
      </Link>
    );
  };

  return (
    <>
      <aside
        className={cn(
          "flex flex-col border-r border-border bg-sidebar min-h-full transition-all duration-200 select-none",
          isCompact ? "w-[56px]" : "w-[228px]"
        )}
      >
        {/* Brand Bar */}
        <div
          className={cn(
            "h-[52px] shrink-0 flex items-center justify-between border-b border-border",
            isCompact ? "px-1.5 justify-center" : "px-3.5"
          )}
        >
          <Link href="/dashboard/usage" prefetch={false} className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex items-center justify-center size-7 bg-[#111111] text-white dark:bg-[#fafafa] dark:text-[#111111] rounded-lg font-mono text-[11px] font-bold tracking-tight shrink-0">
              888
            </span>
            {!isCompact && (
              <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="text-[13px] font-semibold tracking-tight text-text-main truncate">
                  {APP_CONFIG.name}
                </span>
                <span className="font-mono text-[10px] text-text-subtle tabular-nums">
                  v{APP_CONFIG.version}
                </span>
              </div>
            )}
          </Link>

          {!onClose && !isCompact && (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="size-7 rounded-lg flex items-center justify-center border border-transparent hover:border-border hover:bg-surface-2 text-text-muted hover:text-text-main transition-colors"
              title="Collapse navigation"
              aria-label="Collapse sidebar"
            >
              <span className="material-symbols-outlined text-[16px]">dock_to_left</span>
            </button>
          )}
        </div>

        {isCompact && !onClose && (
          <div className="flex justify-center py-1.5 border-b border-border-subtle">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="size-6 flex items-center justify-center border border-transparent hover:border-border text-text-muted hover:text-text-main transition-colors"
              title="Expand catalog rail"
              aria-label="Expand sidebar"
            >
              <span className="material-symbols-outlined text-[15px]">dock_to_right</span>
            </button>
          </div>
        )}

        {!isCompact && updateInfo && (
          <div className="mx-2.5 mt-2.5 p-2.5 rounded-lg border border-border bg-bg-alt space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] text-text-main font-medium">
              <span className="size-1.5 rounded-full bg-[#a6c23f] shrink-0" />
              <span>Update v{updateInfo.latestVersion} ready</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowUpdateModal(true)}
                className="px-2 py-0.5 bg-[#111111] text-white dark:bg-[#fafafa] dark:text-[#111111] rounded-md text-[11px] font-medium cursor-pointer"
              >
                Update
              </button>
              <button
                type="button"
                onClick={() => copy(INSTALL_CMD)}
                className="flex-1 text-left font-mono text-[10px] text-text-muted truncate hover:text-text-main cursor-pointer"
                title="Copy install command"
              >
                {copied ? "Copied" : INSTALL_CMD}
              </button>
            </div>
          </div>
        )}

        {/* Navigation */}
        <nav className={cn("flex-1 overflow-y-auto custom-scrollbar py-3 space-y-4", isCompact ? "px-1.5" : "px-2.5")}>
          <div>
            {!isCompact && (
              <div className="px-2.5 pb-1.5 text-[11px] font-medium text-text-subtle">
                Observability
              </div>
            )}
            <div className="space-y-0.5">{TELEMETRY_ITEMS.map(renderLink)}</div>
          </div>

          <div className="pt-2.5 border-t border-border-subtle">
            {!isCompact && (
              <div className="px-2.5 pb-1.5 text-[11px] font-medium text-text-subtle">
                Routing
              </div>
            )}
            <div className="space-y-0.5">{ROUTING_ITEMS.map(renderLink)}</div>
          </div>

          <div className="pt-2.5 border-t border-border-subtle">
            {!isCompact && (
              <div className="px-2.5 pb-1.5 text-[11px] font-medium text-text-subtle">
                System
              </div>
            )}
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={() => {
                  if (isCompact) setCollapsed(false);
                  setMediaOpen((v) => !v);
                }}
                title="Media Routing"
                className={cn(
                  "w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border transition-colors cursor-pointer",
                  isCompact && "justify-center px-0",
                  pathname.startsWith("/dashboard/media-providers")
                    ? "border-border-subtle bg-surface-2 text-text-main font-medium"
                    : "border-transparent text-text-muted hover:text-text-main hover:bg-surface-2/60"
                )}
              >
                <span className="material-symbols-outlined text-[17px] shrink-0">perm_media</span>
                {!isCompact && (
                  <>
                    <span className="text-[13px] font-medium flex-1 text-left truncate">Media Routing</span>
                    <span
                      className="material-symbols-outlined text-[15px] transition-transform"
                      style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                    >
                      expand_more
                    </span>
                  </>
                )}
              </button>

              {mediaOpen && !isCompact && (
                <div className="pl-3 space-y-0.5 border-l border-border ml-4">
                  {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                    <Link
                      key={kind.id}
                      href={`/dashboard/media-providers/${kind.id}`}
                      prefetch={false}
                      onClick={onClose}
                      className={cn(
                        "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors",
                        pathname.startsWith(`/dashboard/media-providers/${kind.id}`)
                          ? "text-text-main font-medium bg-surface-2"
                          : "text-text-muted hover:text-text-main hover:bg-surface-2/50"
                      )}
                    >
                      <span className="material-symbols-outlined text-[14px]">{kind.icon}</span>
                      <span className="truncate">{kind.label}</span>
                    </Link>
                  ))}
                  <Link
                    key={COMBINED_WEB_ITEM.id}
                    href={COMBINED_WEB_ITEM.href}
                    prefetch={false}
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors",
                      pathname.startsWith(COMBINED_WEB_ITEM.href)
                        ? "text-text-main font-medium bg-surface-2"
                        : "text-text-muted hover:text-text-main hover:bg-surface-2/50"
                    )}
                  >
                    <span className="material-symbols-outlined text-[14px]">{COMBINED_WEB_ITEM.icon}</span>
                    <span className="truncate">{COMBINED_WEB_ITEM.label}</span>
                  </Link>
                </div>
              )}

              {SYSTEM_ITEMS.filter((item) => !item.requiresTranslator || enableTranslator).map(renderLink)}
            </div>
          </div>
        </nav>

        {/* Bottom Gateway Status */}
        {!isCompact && (
          <div className="px-3.5 py-2.5 border-t border-border bg-bg-alt flex items-center justify-between text-[11px] text-text-muted">
            <span className="font-medium">Local Gateway</span>
            <span className="inline-flex items-center gap-1.5 font-medium text-text-main">
              <span className="size-2 rounded-full bg-[#a6c23f] inline-block" />
              Online
            </span>
          </div>
        )}
      </aside>

      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update 888router"
        message={`Show install command for v${updateInfo?.latestVersion || ""}? You can copy it and shutdown to install manually.`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {(isDisconnected || isUpdating) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6">
          {isUpdating ? (
            <ManualUpdatePanel
              latestVersion={updateInfo?.latestVersion}
              installCmd={INSTALL_CMD}
              copied={copied}
              onCopyAndShutdown={handleCopyAndShutdown}
              onCancel={handleCancelUpdate}
              countdown={shutdownCountdown}
              isDisconnected={isDisconnected}
            />
          ) : (
            <div className="text-center p-8 rounded-xl border border-border bg-surface max-w-sm shadow-lg">
              <div className="flex items-center justify-center size-12 rounded-xl border border-red-500/30 bg-red-500/10 text-red-500 mx-auto mb-4">
                <span className="material-symbols-outlined text-[24px]">power_off</span>
              </div>
              <h2 className="text-base font-semibold text-text-main mb-2">Server Disconnected</h2>
              <p className="text-xs text-text-muted mb-5">The proxy server has been stopped.</p>
              <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                Reload Page
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};

function ManualUpdatePanel({ latestVersion, installCmd, copied, onCopyAndShutdown, onCancel, countdown, isDisconnected }) {
  const isCountingDown = countdown > 0;
  return (
    <div className="w-full max-w-lg rounded-xl bg-surface border border-border p-6 text-text-main shadow-xl">
      <div className="flex items-center gap-3 mb-4 pb-3 border-b border-border-subtle">
        <div className="flex items-center justify-center size-10 rounded-lg border border-border bg-surface-2 text-text-main">
          <span className="material-symbols-outlined text-[20px]">content_copy</span>
        </div>
        <div>
          <h2 className="text-base font-semibold">Update 888router{latestVersion ? ` to v${latestVersion}` : ""}</h2>
          <p className="text-xs text-text-muted">
            {isDisconnected
              ? "Server stopped. Paste the command into a terminal to install."
              : isCountingDown
                ? `Command copied. Server will stop in ${countdown}s...`
                : "Copy the install command and shutdown."}
          </p>
        </div>
      </div>

      <p className="text-xs font-medium text-text-muted mb-2">Install command</p>
      <div className="w-full px-3 py-2 rounded-lg border border-border bg-bg-alt mb-4">
        <code className="text-xs font-mono text-text-main break-all">{installCmd}</code>
      </div>

      <ol className="text-xs text-text-muted space-y-1 list-decimal list-inside mb-4">
        <li>Click <strong>Copy & Shutdown</strong> below.</li>
        <li>Paste the command into your terminal and press Enter.</li>
        <li>Run <code className="px-1.5 py-0.5 rounded border border-border bg-surface-2">888router</code> again after install.</li>
      </ol>

      {isDisconnected ? (
        <Button variant="secondary" fullWidth onClick={() => globalThis.location.reload()}>
          Reload Page
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={isCountingDown}>
            Cancel
          </Button>
          <Button variant="primary" fullWidth onClick={onCopyAndShutdown} disabled={isCountingDown}>
            {copied ? "Copied — shutting down..." : isCountingDown ? `Shutting down in ${countdown}s` : "Copy & Shutdown"}
          </Button>
        </div>
      )}
    </div>
  );
}

ManualUpdatePanel.propTypes = {
  latestVersion: PropTypes.string,
  installCmd: PropTypes.string.isRequired,
  copied: PropTypes.bool,
  onCopyAndShutdown: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  countdown: PropTypes.number,
  isDisconnected: PropTypes.bool,
};
