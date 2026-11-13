"use client";

import { useState, useEffect } from "react";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { LOCALE_FLAGS } from "@/shared/constants/locales";
import LanguageSwitcher from "./LanguageSwitcher";

function getLocaleFromCookie() {
  if (typeof document === "undefined") return "en";
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : "en";
  return normalizeLocale(value);
}

export default function HeaderLanguage() {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState(getLocaleFromCookie);

  const handleOpen = () => {
    setLocale(getLocaleFromCookie());
    setOpen(true);
  };

  return (
    <>
      <button
        onClick={handleOpen}
        className="flex items-center justify-center size-8 rounded-lg border border-border bg-surface text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer"
        title="Language"
        data-i18n-skip="true"
      >
        <span className="text-sm leading-none">{LOCALE_FLAGS[locale] || "🌐"}</span>
      </button>

      <LanguageSwitcher
        hideTrigger
        isOpen={open}
        onClose={(next) => {
          setOpen(false);
          setLocale(next);
        }}
      />
    </>
  );
}
