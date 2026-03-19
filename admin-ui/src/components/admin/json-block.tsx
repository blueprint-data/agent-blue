import type { ReactElement, ReactNode } from "react";
import { useMemo, useState } from "react";

export function JsonBlock({ value }: { value: unknown }): ReactElement {
  const [copied, setCopied] = useState(false);
  const rawValue = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }, [value]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(rawValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="json-viewer-shell">
      <div className="json-viewer-toolbar">
        <button type="button" className="json-copy-btn" onClick={() => void handleCopy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="json-viewer">
        <JsonTreeNode value={value} depth={0} isLast path="root" />
      </div>
    </div>
  );
}

function JsonTreeNode({
  value,
  depth,
  isLast,
  path,
  label
}: {
  value: unknown;
  depth: number;
  isLast: boolean;
  path: string;
  label?: string;
}): ReactElement {
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === "object" && !isArray;
  const entries = isArray
    ? (value as unknown[]).map((entry, index) => [String(index), entry] as const)
    : isObject
      ? Object.entries(value as Record<string, unknown>)
      : [];
  const [collapsed, setCollapsed] = useState(depth > 1 && entries.length > 0);
  const comma = isLast ? "" : ",";
  const indentStyle = { paddingLeft: `${depth * 1.1}rem` };

  const labelNode = label ? (
    <>
      <span className="json-key">"{label}"</span>
      <span className="json-punctuation">: </span>
    </>
  ) : null;

  if (!(isArray || isObject)) {
    return (
      <div className="json-line" style={indentStyle}>
        <span className="json-toggle-spacer" aria-hidden="true" />
        {labelNode}
        {renderJsonPrimitive(value)}
        <span className="json-punctuation">{comma}</span>
      </div>
    );
  }

  const openToken = isArray ? "[" : "{";
  const closeToken = isArray ? "]" : "}";

  if (entries.length === 0) {
    return (
      <div className="json-line" style={indentStyle}>
        <span className="json-toggle-spacer" aria-hidden="true" />
        {labelNode}
        <span className="json-punctuation">
          {openToken}
          {closeToken}
          {comma}
        </span>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="json-line" style={indentStyle}>
        <button
          type="button"
          className="json-toggle"
          onClick={() => setCollapsed(false)}
          aria-label="Expand JSON node"
        >
          +
        </button>
        {labelNode}
        <span className="json-punctuation">{openToken}</span>
        <span className="json-collapsed">{getJsonSummary(isArray, entries.length)}</span>
        <span className="json-punctuation">
          {closeToken}
          {comma}
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="json-line" style={indentStyle}>
        <button
          type="button"
          className="json-toggle"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse JSON node"
        >
          -
        </button>
        {labelNode}
        <span className="json-punctuation">{openToken}</span>
      </div>
      <div className="json-children">
        {entries.map(([entryLabel, entryValue], index) => (
          <JsonTreeNode
            key={`${path}.${entryLabel}`}
            value={entryValue}
            depth={depth + 1}
            isLast={index === entries.length - 1}
            path={`${path}.${entryLabel}`}
            label={isArray ? undefined : entryLabel}
          />
        ))}
      </div>
      <div className="json-line" style={indentStyle}>
        <span className="json-toggle-spacer" aria-hidden="true" />
        <span className="json-punctuation">
          {closeToken}
          {comma}
        </span>
      </div>
    </>
  );
}

function renderJsonPrimitive(value: unknown): ReactNode {
  if (typeof value === "string") {
    return <span className="json-string">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-number">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-boolean">{String(value)}</span>;
  }
  if (value === null) {
    return <span className="json-null">null</span>;
  }
  if (value === undefined) {
    return <span className="json-null">undefined</span>;
  }
  return <span className="json-string">{JSON.stringify(value)}</span>;
}

function getJsonSummary(isArray: boolean, length: number): string {
  if (isArray) {
    return `${length} item${length === 1 ? "" : "s"}`;
  }
  return `${length} key${length === 1 ? "" : "s"}`;
}
