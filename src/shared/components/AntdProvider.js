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
  return false;
}

export default function AntdProvider({ children }) {
  const themeValue = useThemeStore((s) => s.theme);
  const isDark = resolveDark(themeValue);

  const themeConfig = useMemo(() => ({
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: isDark ? "#fafafa" : "#111111",
      colorInfo: isDark ? "#a1a1aa" : "#52525b",
      colorSuccess: isDark ? "#4ade80" : "#16a34a",
      colorWarning: isDark ? "#fbbf24" : "#d97706",
      colorError: isDark ? "#f87171" : "#dc2626",
      borderRadius: 8,
      borderRadiusLG: 10,
      borderRadiusSM: 6,
      borderRadiusXS: 4,
      fontFamily: "var(--font-inter), 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      fontFamilyCode: "var(--font-mono), 'JetBrains Mono', ui-monospace, monospace",
      colorBgBase: isDark ? "#0a0a0b" : "#fafafa",
      colorBgContainer: isDark ? "#121215" : "#ffffff",
      colorBgElevated: isDark ? "#18181c" : "#ffffff",
      colorBgLayout: isDark ? "#0a0a0b" : "#fafafa",
      colorBorder: isDark ? "#26262c" : "#e2e2e2",
      colorBorderSecondary: isDark ? "#1c1c21" : "#efefef",
      colorText: isDark ? "#fafafa" : "#111111",
      colorTextSecondary: isDark ? "#a1a1aa" : "#6b6b6b",
      colorTextLightSolid: isDark ? "#111111" : "#ffffff",
    },
    components: {
      Button: {
        borderRadius: 8,
        borderRadiusSM: 6,
        borderRadiusLG: 10,
        controlHeight: 34,
        primaryBg: isDark ? "#fafafa" : "#111111",
        primaryColor: isDark ? "#111111" : "#ffffff",
      },
      Input: { borderRadius: 8, borderRadiusSM: 6, borderRadiusLG: 10 },
      Select: { borderRadius: 8, borderRadiusSM: 6, borderRadiusLG: 10 },
      Modal: { borderRadiusLG: 12 },
      Drawer: { colorBgElevated: isDark ? "#121215" : "#ffffff" },
      Table: {
        borderRadius: 8,
        borderRadiusLG: 10,
        headerBg: isDark ? "#141418" : "#f7f7f7",
        headerColor: isDark ? "#a1a1aa" : "#6b6b6b",
        headerSplitColor: isDark ? "#26262c" : "#e6e6e6",
        borderColor: isDark ? "#26262c" : "#e6e6e6",
        rowHoverBg: isDark ? "#18181d" : "#f5f5f5",
        cellPaddingBlockSM: 10,
        cellPaddingInlineSM: 14,
      },
      Segmented: {
        borderRadius: 8,
        borderRadiusSM: 6,
        trackBg: isDark ? "#16161a" : "#f2f2f2",
        itemSelectedBg: isDark ? "#26262d" : "#ffffff",
        itemSelectedColor: isDark ? "#fafafa" : "#111111",
      },
      Tabs: {
        inkBarColor: isDark ? "#fafafa" : "#111111",
        itemSelectedColor: isDark ? "#fafafa" : "#111111",
      },
      Tag: { borderRadiusSM: 6 },
      Card: { borderRadiusLG: 10, paddingLG: 20 },
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
