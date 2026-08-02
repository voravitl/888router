"use client";

import { useEffect, useState } from "react";
import { Card, Badge } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

function CopyButton({ value, label = "Copy link" }) {
  const { copied, copy } = useCopyToClipboard(2000);
  return (
    <button
      onClick={() => copy(value)}
      className="px-2 py-1 rounded-md bg-primary text-white text-[11px] font-medium hover:bg-primary/90 transition-colors cursor-pointer shrink-0 inline-flex items-center gap-1"
      title={value}
    >
      <span className="material-symbols-outlined text-[12px]">
        {copied ? "check" : "content_copy"}
      </span>
      {copied ? "Copied!" : label}
    </button>
  );
}

function SkillRow({ skill, rawUrl }) {
  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-[14px] border shadow-[var(--shadow-soft)] transition-colors ${
        skill.isEntry
          ? "border-brand-500/40 bg-brand-500/5"
          : "border-border-subtle bg-surface hover:bg-surface-2"
      }`}
    >
      <div
        className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
          skill.isEntry ? "bg-primary text-white" : "bg-primary/10 text-primary"
        }`}
      >
        <span className="material-symbols-outlined text-[18px]">{skill.icon}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-sm text-text-main">{skill.name}</h3>
          {skill.isEntry && (
            <Badge variant="primary" size="sm">START HERE</Badge>
          )}
          {skill.endpoint && (
            <Badge variant="default" size="sm">
              <code className="text-[10px]">{skill.endpoint}</code>
            </Badge>
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5">{skill.description}</p>
        <a
          href={rawUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-text-muted hover:text-primary mt-1 inline-flex items-center gap-1 break-all"
        >
          {rawUrl}
          <span className="material-symbols-outlined text-[12px]">open_in_new</span>
        </a>
      </div>

      <CopyButton value={rawUrl} />
    </div>
  );
}

export default function SkillsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    const controller = new AbortController();
    fetch("/api/skills", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        return res.json();
      })
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Card padding="md">
          <p className="text-sm text-red-500">Failed to load skills: {error}</p>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Card padding="md">
          <p className="text-sm text-text-muted">Loading skills…</p>
        </Card>
      </div>
    );
  }

  const entrySkill = data.skills?.find((s) => s.isEntry) || data.skills?.[0];
  const entryRaw = entrySkill
    ? `${origin}${data.rawBase}/${entrySkill.id}`
    : "";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Card padding="md">
        <div className="text-xs text-text-muted mb-2">Paste this to your AI:</div>
        <div className="px-3 py-2 rounded bg-surface-2 font-mono text-[12px] text-text-main">
          {data ? `Read this skill and use it: ${entryRaw}` : "Loading…"}
        </div>
      </Card>

      <div className="space-y-2">
        {!data && !error && (
          <Card padding="md">
            <p className="text-sm text-text-muted">Loading skills…</p>
          </Card>
        )}
        {data?.skills?.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            rawUrl={`${origin}${data.rawBase}/${skill.id}`}
          />
        ))}
      </div>

      <Card padding="md">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-text-main">About skills</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Skills are served from this gateway — paste the raw link to your AI to load it.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
