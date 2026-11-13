"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import HeaderMenu from "@/shared/components/HeaderMenu";
import HeaderLanguage from "@/shared/components/HeaderLanguage";
import ThemeToggle from "@/shared/components/ThemeToggle";
import CommandPalette from "@/shared/components/CommandPalette";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "@/shared/constants/providers";
import { translate } from "@/i18n/runtime";

const getPageInfo = (pathname) => {
  if (!pathname) return { title: "", breadcrumbs: [] };

  const mediaDetailMatch = pathname.match(/\/media-providers\/([^/]+)\/([^/]+)$/);
  if (mediaDetailMatch) {
    const kindId = mediaDetailMatch[1];
    const providerId = mediaDetailMatch[2];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    const provider = AI_PROVIDERS[providerId];
    return {
      title: provider?.name || providerId,
      breadcrumbs: [
        { label: kindConfig?.label || kindId, href: `/dashboard/media-providers/${kindId}` },
        { label: provider?.name || providerId, image: `/providers/${providerId}.png` },
      ],
    };
  }

  const mediaKindMatch = pathname.match(/\/media-providers\/([^/]+)$/);
  if (mediaKindMatch) {
    const kindId = mediaKindMatch[1];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    return { title: kindConfig?.label || kindId, breadcrumbs: [] };
  }

  const providerMatch = pathname.match(/\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = providerMatch[1];
    const providerInfo = OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId];
    if (providerInfo) {
      return {
        title: providerInfo.name,
        breadcrumbs: [
          { label: "Providers", href: "/dashboard/providers" },
          { label: providerInfo.name, image: `/providers/${providerInfo.id}.png` },
        ],
      };
    }
  }

  if (pathname.includes("/usage")) return { title: "Usage & Traces", breadcrumbs: [] };
  if (pathname === "/dashboard" || pathname.includes("/endpoint")) return { title: "Gateway & Keys", breadcrumbs: [] };
  if (pathname.includes("/quota")) return { title: "Quota Tracker", breadcrumbs: [] };
  if (pathname.includes("/token-saver")) return { title: "Token Savings", breadcrumbs: [] };
  if (pathname.includes("/providers")) return { title: "Providers", breadcrumbs: [] };
  if (pathname.includes("/combos")) return { title: "Combos", breadcrumbs: [] };
  if (pathname.includes("/basic-chat")) return { title: "Test Chat", breadcrumbs: [] };
  if (pathname.includes("/cli-tools")) return { title: "CLI Tools", breadcrumbs: [] };
  if (pathname.includes("/proxy-pools")) return { title: "Proxy Pools", breadcrumbs: [] };
  if (pathname.includes("/skills")) return { title: "Agent Skills", breadcrumbs: [] };
  if (pathname.includes("/console-log")) return { title: "Console Log", breadcrumbs: [] };
  if (pathname.includes("/translator")) return { title: "Translator", breadcrumbs: [] };
  if (pathname.includes("/profile")) return { title: "Settings", breadcrumbs: [] };
  if (pathname.includes("/mitm")) return { title: "MITM Proxy", breadcrumbs: [] };
  if (pathname.includes("/auth-files")) return { title: "Auth Files", breadcrumbs: [] };
  return { title: "Dashboard", breadcrumbs: [] };
};

export default function Header({ onMenuClick, showMenuButton = true }) {
  const pathname = usePathname();
  const [displayName, setDisplayName] = useState("");
  const [loginMethod, setLoginMethod] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);

  const pageInfo = useMemo(() => getPageInfo(pathname), [pathname]);
  const { title, breadcrumbs } = pageInfo;

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadAuthStatus() {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setDisplayName(data?.displayName || data?.samlName || data?.samlEmail || data?.oidcName || data?.oidcEmail || "");
          setLoginMethod(data?.loginMethod || "");
        }
      } catch {
        if (!cancelled) {
          setDisplayName("");
          setLoginMethod("");
        }
      }
    }
    loadAuthStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        window.location.assign("/login");
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <>
      <header className="h-[52px] shrink-0 flex items-center justify-between gap-3 px-4 border-b border-border bg-surface z-20">
        {/* Left: Mobile drawer trigger + Breadcrumb */}
        <div className="flex items-center gap-3 min-w-0">
          {showMenuButton && (
            <button
              type="button"
              onClick={onMenuClick}
              className="lg:hidden size-8 rounded-lg flex items-center justify-center border border-border text-text-main hover:bg-surface-2 transition-colors"
              aria-label="Open navigation"
            >
              <span className="material-symbols-outlined text-[18px]">menu</span>
            </button>
          )}

          <div className="flex items-center gap-2 min-w-0 text-[13px]">
            <span className="text-text-muted shrink-0 hidden sm:inline font-medium">888router</span>
            <span className="text-text-subtle shrink-0 hidden sm:inline">/</span>
            {breadcrumbs.length > 0 ? (
              <div className="flex items-center gap-1.5 min-w-0">
                {breadcrumbs.map((crumb, index) => (
                  <div key={`${crumb.label}-${crumb.href || "current"}`} className="flex items-center gap-1.5 min-w-0">
                    {index > 0 && <span className="text-text-subtle">/</span>}
                    {crumb.href ? (
                      <Link href={crumb.href} className="text-text-muted hover:text-text-main truncate">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-text-main font-semibold truncate">
                        {crumb.image && (
                          <ProviderIcon
                            src={crumb.image}
                            alt={crumb.label}
                            size={16}
                            className="object-contain max-w-[16px] max-h-[16px]"
                            fallbackText={crumb.label.slice(0, 2).toUpperCase()}
                          />
                        )}
                        <span className="truncate font-sans text-sm">{translate(crumb.label)}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <span className="font-sans text-sm font-semibold text-text-main truncate">
                {translate(title)}
              </span>
            )}
          </div>
        </div>

        {/* Center: Cmd+K Quick Jump */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="hidden md:flex items-center justify-between gap-4 px-3 h-8 w-[240px] lg:w-[300px] rounded-lg border border-border bg-bg-alt hover:bg-surface-2/60 transition-colors text-text-muted cursor-pointer"
          title="Open Command Palette (⌘K)"
        >
          <span className="flex items-center gap-2 text-xs truncate">
            <span className="material-symbols-outlined text-[15px]">search</span>
            Jump to route, provider, combo...
          </span>
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface text-text-subtle">
            ⌘K
          </kbd>
        </button>

        {/* Right: Search + Auth + System Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {displayName && (loginMethod === "OIDC" || loginMethod === "SAML") && (
            <div
              className="hidden sm:flex items-center max-w-[180px] px-2.5 h-8 rounded-lg border border-border bg-bg-alt text-xs text-text-muted truncate"
              title={displayName}
            >
              <span className="truncate">{displayName}</span>
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-surface-2 text-[10px] font-medium text-text-main uppercase">
                {loginMethod}
              </span>
            </div>
          )}

          <HeaderSearch />

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="md:hidden size-8 rounded-lg flex items-center justify-center border border-border bg-surface text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors"
            aria-label="Open command search"
          >
            <span className="material-symbols-outlined text-[16px]">search</span>
          </button>

          <ThemeToggle className="!size-8 !rounded-lg border border-border bg-surface hover:bg-surface-2" />
          <HeaderLanguage />
          <HeaderMenu onLogout={handleLogout} />
        </div>
      </header>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

function HeaderSearch() {
  const visible = useHeaderSearchStore((s) => s.visible);
  const query = useHeaderSearchStore((s) => s.query);
  const placeholder = useHeaderSearchStore((s) => s.placeholder);
  const setQuery = useHeaderSearchStore((s) => s.setQuery);

  if (!visible) return null;

  return (
    <div className="relative w-[150px] sm:w-[190px]">
      <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[15px] pointer-events-none">
        filter_list
      </span>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full h-8 pl-8 pr-7 rounded-lg border border-border bg-surface text-xs text-text-main focus:outline-none focus:border-text-main transition-colors"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
          aria-label="Clear filter"
        >
          <span className="material-symbols-outlined text-[14px]">close</span>
        </button>
      )}
    </div>
  );
}

Header.propTypes = {
  onMenuClick: PropTypes.func,
  showMenuButton: PropTypes.bool,
};
