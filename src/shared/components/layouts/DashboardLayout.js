"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { usePathname } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import Sidebar from "../Sidebar";
import Header from "../Header";

function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: "border-[#a6c23f]/40 bg-surface text-text-main",
      icon: "check_circle",
      iconClass: "text-[#7a9422] dark:text-[#a6c23f]",
    };
  }
  if (type === "error") {
    return {
      wrapper: "border-red-600/35 bg-surface text-red-700 dark:text-red-400",
      icon: "error",
      iconClass: "text-[#dc2626]",
    };
  }
  if (type === "warning") {
    return {
      wrapper: "border-border bg-surface text-text-main",
      icon: "warning",
      iconClass: "text-text-main",
    };
  }
  return {
    wrapper: "border-border bg-surface text-text-main",
    icon: "info",
    iconClass: "text-text-muted",
  };
}

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);
  const isBasicChat = pathname === "/dashboard/basic-chat";

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg text-text-main">
      {notifications.length > 0 && (
        <div className="fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2">
          {notifications.map((n) => {
            const style = getToastStyle(n.type);
            return (
              <div
                key={n.id}
                className={`rounded-xl border px-3.5 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.45)] ${style.wrapper}`}
              >
                <div className="flex items-start gap-2.5">
                  <span className={`material-symbols-outlined text-[18px] leading-5 shrink-0 ${style.iconClass}`}>
                    {style.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                    <p className="text-xs whitespace-pre-wrap break-words text-text-muted">{n.message}</p>
                  </div>
                  {n.dismissible ? (
                    <button
                      type="button"
                      onClick={() => removeNotification(n.id)}
                      className="text-text-muted hover:text-text-main"
                      aria-label="Dismiss notification"
                    >
                      <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Desktop architectural catalog rail */}
      <div className="hidden lg:flex shrink-0 h-full">
        <Sidebar />
      </div>

      {/* Mobile Drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fixed inset-0 bg-black/65"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 left-0 z-50 flex h-full">
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex flex-col flex-1 h-full min-w-0 overflow-hidden bg-bg">
        <Header key={pathname} onMenuClick={() => setSidebarOpen(true)} />
        <div
          className={`flex-1 overflow-y-auto custom-scrollbar ${
            isBasicChat ? "flex flex-col overflow-hidden p-0" : "p-4 lg:p-6"
          }`}
        >
          <div className={isBasicChat ? "flex-1 w-full h-full flex flex-col" : "max-w-[1440px] mx-auto w-full"}>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

DashboardLayout.propTypes = {
  children: PropTypes.node.isRequired,
};
