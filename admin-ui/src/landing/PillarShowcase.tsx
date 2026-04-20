import { useEffect, useRef, useState } from "react";

type GlyphKey = "chat" | "charts" | "schedule" | "governance";

interface Pillar {
  title: string;
  description: string;
  glyph: GlyphKey;
}

const PILLARS: Pillar[] = [
  {
    title: "Works inside your team's chat",
    description: "Ask in Slack or Telegram. No new tool to learn.",
    glyph: "chat"
  },
  {
    title: "Answers, charts and dashboards",
    description: "Backed by your dbt models, delivered to the channel.",
    glyph: "charts"
  },
  {
    title: "Scheduled reports",
    description: "Set the cadence. Agent Blue posts insights automatically.",
    glyph: "schedule"
  },
  {
    title: "Governance without friction",
    description: "Channel-level permissions and role-based access, built in.",
    glyph: "governance"
  }
];

function ChatGlyph() {
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true" className="pillar-glyph__svg">
      <defs>
        <linearGradient id="pg-chat-bubble-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5151f3" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#5151f3" stopOpacity="0.32" />
        </linearGradient>
        <linearGradient id="pg-chat-bubble-b" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22eaed" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#22eaed" stopOpacity="0.4" />
        </linearGradient>
      </defs>

      <g className="pillar-glyph-chat__inbound">
        <rect x="6" y="14" width="58" height="26" rx="13" fill="url(#pg-chat-bubble-a)" stroke="rgba(81,81,243,0.42)" />
        <circle cx="20" cy="27" r="2.4" fill="#5151f3" />
        <circle cx="32" cy="27" r="2.4" fill="#5151f3" />
        <circle cx="44" cy="27" r="2.4" fill="#5151f3" />
      </g>

      <g className="pillar-glyph-chat__outbound">
        <rect x="56" y="44" width="58" height="26" rx="13" fill="url(#pg-chat-bubble-b)" stroke="rgba(34,234,237,0.55)" />
        <path d="M68 57h32" stroke="#0c8a8c" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M68 62h22" stroke="#0c8a8c" strokeWidth="2.4" strokeLinecap="round" opacity="0.65" />
      </g>
    </svg>
  );
}

function ChartsGlyph() {
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true" className="pillar-glyph__svg">
      <defs>
        <linearGradient id="pg-bar" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#5151f3" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#22eaed" stopOpacity="0.95" />
        </linearGradient>
      </defs>

      <line x1="10" y1="68" x2="112" y2="68" stroke="rgba(15,23,42,0.18)" strokeWidth="1.2" />

      <g className="pillar-glyph-charts__bars">
        <rect className="pillar-glyph-charts__bar" x="16" y="40" width="14" height="28" rx="3" fill="url(#pg-bar)" />
        <rect className="pillar-glyph-charts__bar" x="36" y="28" width="14" height="40" rx="3" fill="url(#pg-bar)" />
        <rect className="pillar-glyph-charts__bar" x="56" y="48" width="14" height="20" rx="3" fill="url(#pg-bar)" />
        <rect className="pillar-glyph-charts__bar" x="76" y="20" width="14" height="48" rx="3" fill="url(#pg-bar)" />
      </g>

      <path
        className="pillar-glyph-charts__spark"
        d="M16 50 L36 38 L56 44 L76 24 L102 18"
        fill="none"
        stroke="#5151f3"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle className="pillar-glyph-charts__dot" cx="102" cy="18" r="3.4" fill="#5151f3" />
    </svg>
  );
}

function ScheduleGlyph() {
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true" className="pillar-glyph__svg">
      <defs>
        <radialGradient id="pg-clock" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#eef0ff" />
        </radialGradient>
      </defs>

      <g className="pillar-glyph-schedule__cal">
        <rect x="10" y="18" width="44" height="44" rx="6" fill="#fff" stroke="rgba(81,81,243,0.35)" />
        <rect x="10" y="18" width="44" height="10" rx="6" fill="rgba(81,81,243,0.16)" />
        <circle cx="20" cy="36" r="2" fill="rgba(81,81,243,0.5)" />
        <circle cx="32" cy="36" r="2" fill="rgba(81,81,243,0.5)" />
        <circle cx="44" cy="36" r="2" fill="rgba(81,81,243,0.5)" />
        <circle cx="20" cy="46" r="2" fill="rgba(81,81,243,0.5)" />
        <circle className="pillar-glyph-schedule__day" cx="32" cy="46" r="2.6" fill="#5151f3" />
        <circle cx="44" cy="46" r="2" fill="rgba(81,81,243,0.5)" />
        <circle cx="20" cy="55" r="2" fill="rgba(81,81,243,0.35)" />
        <circle cx="32" cy="55" r="2" fill="rgba(81,81,243,0.35)" />
        <circle cx="44" cy="55" r="2" fill="rgba(81,81,243,0.35)" />
      </g>

      <g transform="translate(86 40)">
        <circle r="22" fill="url(#pg-clock)" stroke="rgba(34,234,237,0.55)" strokeWidth="1.6" />
        <circle r="1.6" fill="#0c8a8c" />
        <line className="pillar-glyph-schedule__hour" x1="0" y1="0" x2="0" y2="-9" stroke="#0c8a8c" strokeWidth="2.2" strokeLinecap="round" />
        <line className="pillar-glyph-schedule__minute" x1="0" y1="0" x2="0" y2="-15" stroke="#5151f3" strokeWidth="1.8" strokeLinecap="round" />
      </g>
    </svg>
  );
}

function GovernanceGlyph() {
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true" className="pillar-glyph__svg">
      <defs>
        <linearGradient id="pg-shield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(81,81,243,0.18)" />
          <stop offset="100%" stopColor="rgba(34,234,237,0.22)" />
        </linearGradient>
      </defs>

      <g transform="translate(60 40)">
        <path
          className="pillar-glyph-governance__shield"
          d="M0 -28 L24 -18 L24 4 C24 18 14 28 0 32 C-14 28 -24 18 -24 4 L-24 -18 Z"
          fill="url(#pg-shield)"
          stroke="rgba(81,81,243,0.55)"
          strokeWidth="1.6"
        />
        <path
          className="pillar-glyph-governance__check"
          d="M-9 2 L-2 9 L11 -6"
          fill="none"
          stroke="#5151f3"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>

      <g className="pillar-glyph-governance__orbits" transform="translate(60 40)">
        <circle r="34" fill="none" stroke="rgba(81,81,243,0.18)" strokeDasharray="2 6" />
        <circle className="pillar-glyph-governance__particle" r="2.6" cx="34" cy="0" fill="#22eaed" />
      </g>
    </svg>
  );
}

function Glyph({ kind }: { kind: GlyphKey }) {
  switch (kind) {
    case "chat":
      return <ChatGlyph />;
    case "charts":
      return <ChartsGlyph />;
    case "schedule":
      return <ScheduleGlyph />;
    case "governance":
      return <GovernanceGlyph />;
  }
}

export default function PillarShowcase() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setVisible(true);
      return;
    }

    const node = containerRef.current;
    if (!node) return;

    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.18 }
    );

    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={`pillar-showcase${visible ? " is-visible" : ""}`}
    >
      {PILLARS.map((pillar, i) => (
        <article
          key={pillar.title}
          className={`pillar-card pillar-card--${pillar.glyph}`}
          style={{ "--pillar-delay": `${i * 90}ms` } as React.CSSProperties}
        >
          <div className="pillar-card__art" aria-hidden="true">
            <div className="pillar-card__art-glow" />
            <Glyph kind={pillar.glyph} />
          </div>
          <div className="pillar-card__body">
            <h3 className="pillar-card__title">{pillar.title}</h3>
            <p className="pillar-card__description">{pillar.description}</p>
          </div>
        </article>
      ))}
    </div>
  );
}
