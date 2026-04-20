import { useEffect, useRef, useState } from "react";

type StepIconKey = "connect" | "link" | "access" | "ask";

interface OnboardingStep {
  title: string;
  description: string;
  icon: StepIconKey;
}

const STEPS: OnboardingStep[] = [
  {
    title: "Connect the bot",
    description: "Add to Slack or Telegram in minutes.",
    icon: "connect"
  },
  {
    title: "Link your data stack",
    description: "Plug in your dbt repo and warehouse.",
    icon: "link"
  },
  {
    title: "Set access rules",
    description: "Channel permissions and role-based access.",
    icon: "access"
  },
  {
    title: "Ask away",
    description: "Natural language in, traceable answers out.",
    icon: "ask"
  }
];

const AUTO_ADVANCE_MS = 3200;

function StepIcon({ icon }: { icon: StepIconKey }) {
  switch (icon) {
    case "connect":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      );
    case "link":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
          <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
        </svg>
      );
    case "access":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2 4 6v6c0 5 3.5 9.3 8 10 4.5-.7 8-5 8-10V6l-8-4z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "ask":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2 14 8l6 2-6 2-2 6-2-6-6-2 6-2 2-6z" />
          <path d="M19 14v4M21 16h-4" />
        </svg>
      );
  }
}

export default function OnboardingFlow() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const reduceMotion = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    reduceMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion.current) {
      setActiveIndex(STEPS.length - 1);
    }
  }, []);

  useEffect(() => {
    if (reduceMotion.current || isPaused) return;
    const id = window.setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % STEPS.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [isPaused]);

  const progress = STEPS.length > 1 ? activeIndex / (STEPS.length - 1) : 0;
  const active = STEPS[activeIndex];

  return (
    <div
      className="onboarding-flow bp-card"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
    >
      <div
        className="onboarding-flow__rail"
        role="tablist"
        aria-label="Onboarding steps"
      >
        <div className="onboarding-flow__track" aria-hidden="true">
          <div
            className="onboarding-flow__track-fill"
            style={{ width: `${progress * 100}%` }}
          />
          <span
            className="onboarding-flow__packet"
            style={{ left: `${progress * 100}%` }}
          />
        </div>

        <ol className="onboarding-flow__stations">
          {STEPS.map((step, i) => {
            const isActive = i === activeIndex;
            const isComplete = i < activeIndex;
            return (
              <li
                key={step.title}
                className={[
                  "onboarding-flow__station",
                  isActive && "is-active",
                  isComplete && "is-complete"
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls="onboarding-flow-detail"
                  className="onboarding-flow__node"
                  onClick={() => setActiveIndex(i)}
                >
                  <span className="onboarding-flow__node-glow" aria-hidden="true" />
                  <span className="onboarding-flow__node-icon" aria-hidden="true">
                    <StepIcon icon={step.icon} />
                  </span>
                  <span className="onboarding-flow__node-index" aria-hidden="true">
                    {i + 1}
                  </span>
                </button>
                <span className="onboarding-flow__label">{step.title}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <div
        id="onboarding-flow-detail"
        className="onboarding-flow__detail"
        role="tabpanel"
        aria-live="polite"
      >
        <span className="onboarding-flow__step-tag">
          Step {activeIndex + 1} of {STEPS.length}
        </span>
        <h3 key={`title-${activeIndex}`} className="onboarding-flow__title">
          {active.title}
        </h3>
        <p key={`desc-${activeIndex}`} className="onboarding-flow__description">
          {active.description}
        </p>
      </div>
    </div>
  );
}
