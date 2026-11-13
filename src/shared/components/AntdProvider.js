"use client";

import { useMemo } from "react";
import PropTypes from "prop-types";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App as AntApp, ConfigProvider, theme as antdTheme } from "antd";
import useThemeStore from "@/store/themeStore";

function resolveDark(themeValue) {
  if (themeValue === "light") return false;
  if (themeValue === "dark") return true;
  if (typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return true;
}

export default function AntdProvider({ children }) {
  const themeValue = useThemeStore((s) => s.theme);
  const isDark = resolveDark(themeValue);

  const themeConfig = useMemo(() => ({
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: "#f59e0b",
      colorInfo: "#06b6d4",
      colorSuccess: "#10b981",
      colorWarning: "#fbbf24",
      colorError: "#f43f5e",
      borderRadius: 12,
      borderRadiusLG: 16,
      borderRadiusSM: 8,
      fontFamily: "var(--font-inter), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      motionDurationMid: "0.22s",
      motionEaseOut: "cubic-bezier(0.22, 1, 0.36, 1)",
      ...(isDark
        ? {
            colorBgBase: "#09090b",
            colorBgLayout: "#09090b",
            colorBgContainer: "#14141a",
            colorBgElevated: "#1c1c24",
            colorBorder: "rgba(255, 255, 255, 0.1)",
            colorBorderSecondary: "rgba(255, 255, 255, 0.06)",
            colorText: "#fafafa",
            colorTextSecondary: "#a1a1aa",
          }
        : {
            colorBgLayout: "#f8fafc",
            colorBgContainer: "#ffffff",
            colorBgElevated: "#ffffff",
            colorBorder: "#e2e8f0",
            colorBorderSecondary: "#f1f5f9",
          }),
    },
    components: {
      Card: {
        borderRadiusLG: 16,
        paddingLG: 20,
      },
      Modal: {
        borderRadiusLG: 16,
      },
      Button: {
        borderRadius: 10,
        controlHeight: 36,
        fontWeight: 600,
      },
      Input: {
        borderRadius: 10,
        controlHeight: 38,
      },
      Select: {
        borderRadius: 10,
        controlHeight: 38,
      },
      Table: {
        borderRadiusLG: 14,
      },
    },
  }), [isDark]);

  return (
    <AntdRegistry>
      <ConfigProvider theme={themeConfig}>
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </AntdRegistry>
  );
}

AntdProvider.propTypes = {
  children: PropTypes.node.isRequired,
};
