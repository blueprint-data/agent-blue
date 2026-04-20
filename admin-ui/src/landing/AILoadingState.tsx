import { useEffect, useMemo, useState } from "react";

const TASK_SEQUENCES = [
  {
    status: "Querying your warehouse",
    lines: [
      "Resolving dbt model: cohort_churn_v3...",
      "Fetching acquisition segments...",
      "Joining LTV and retention data..."
    ]
  },
  {
    status: "Building dashboard",
    lines: [
      "Aggregating by acquisition channel...",
      "Preparing churn breakdown chart...",
      "Rendering cohort dashboard..."
    ]
  },
  {
    status: "Publishing to Slack",
    lines: [
      "Attaching traceability summary...",
      "Formatting charts for Slack...",
      "Sending dashboard to channel..."
    ]
  }
];

function LoadingAnimation({ progress }: { progress: number }) {
  const dash = (progress / 100) * 754;

  return (
    <div className="landing-loading-icon" aria-hidden="true">
      <svg viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <mask id="landing-progress-mask">
            <rect fill="black" width="240" height="240" />
            <circle
              cx="120"
              cy="120"
              r="120"
              fill="white"
              strokeDasharray={`${dash}, 754`}
              transform="rotate(-90 120 120)"
            />
          </mask>
        </defs>
        <g className="landing-loading-rings" mask="url(#landing-progress-mask)" strokeDasharray="20% 42%" strokeWidth="16">
          <circle cx="120" cy="120" r="148" stroke="#5151F3" opacity="0.95" />
          <circle cx="120" cy="120" r="126" stroke="#22EAED" opacity="0.9" />
          <circle cx="120" cy="120" r="104" stroke="#6F4CFF" opacity="0.88" />
          <circle cx="120" cy="120" r="82" stroke="#4DD7FB" opacity="0.86" />
        </g>
      </svg>
    </div>
  );
}

export default function AILoadingState() {
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);

  const currentSequence = TASK_SEQUENCES[sequenceIndex];

  useEffect(() => {
    setLineIndex(0);
  }, [sequenceIndex]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLineIndex((prev) => {
        const next = prev + 1;
        if (next >= currentSequence.lines.length) {
          setSequenceIndex((s) => (s + 1) % TASK_SEQUENCES.length);
          return 0;
        }
        return next;
      });
    }, 1600);
    return () => window.clearInterval(timer);
  }, [currentSequence.lines.length]);

  const progress = useMemo(() => {
    const base = sequenceIndex / TASK_SEQUENCES.length;
    const local = lineIndex / currentSequence.lines.length;
    return Math.min((base + local / TASK_SEQUENCES.length) * 100, 100);
  }, [currentSequence.lines.length, lineIndex, sequenceIndex]);

  return (
    <div className="landing-loading-card" aria-label="Agent Blue processing">
      <div className="landing-loading-header">
        <LoadingAnimation progress={progress} />
        <p>{currentSequence.status}...</p>
      </div>
      <div className="landing-loading-step">
        {currentSequence.lines[lineIndex]}
      </div>
    </div>
  );
}
