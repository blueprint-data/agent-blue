import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { faSlack, faTelegram } from "@fortawesome/free-brands-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import logoSrc from "@/assets/logo.png";
import sofiaAvatarSrc from "@/assets/sofia.png";
import { AnimatedText } from "@/components/ui/animated-text";
import { BlueprintCard } from "@/components/ui/blueprint-card";
import { Button } from "@/components/ui/button";
import SoftAurora from "@/components/ui/soft-aurora";
import AILoadingState from "./AILoadingState";
import OnboardingFlow from "./OnboardingFlow";
import PillarShowcase from "./PillarShowcase";
import "./landing.css";

const LANDING_MOBILE_MENU_ID = "landing-mobile-menu";

type ChatRole = "user" | "bot";
interface ChatMessage {
  role: ChatRole;
  name?: string;
  text: string;
  chart?: string;
}

const chatMessages: ChatMessage[] = [
  { role: "user", name: "Sofia R.", text: "What's driving churn in our top cohort this quarter?" },
  {
    role: "bot",
    text: "Churn up 1.8pp. Month-4 downgrades show 3x higher 90-day churn. ~$420K ARR at risk.",
    chart: "churn_by_cohort · LTV risk"
  },
  { role: "user", name: "Sofia R.", text: "Show revenue by acquisition channel" }
];

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = e.target as Node;
      if (menuToggleRef.current?.contains(node)) return;
      if (menuPanelRef.current?.contains(node)) return;
      setMobileMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [mobileMenuOpen]);

  return (
    <div className="landing-root">
    <div className="landing-shell">
      <div className="landing-aurora-global" aria-hidden="true">
        <SoftAurora
          speed={0.4}
          scale={1.12}
          brightness={0.72}
          color1="#5151f3"
          color2="#22eaed"
          noiseFrequency={2.45}
          noiseAmplitude={0.58}
          bandHeight={0.6}
          bandSpread={0.78}
          octaveDecay={0.2}
          layerOffset={0.2}
          colorSpeed={0.44}
          enableMouseInteraction
          mouseInfluence={0.08}
        />
      </div>

      <header
        className={`landing-topbar bp-card${mobileMenuOpen ? " landing-topbar--menu-open" : ""}`}
        aria-label="Primary navigation"
      >
        <a className="landing-brand" href="/" aria-label="Agent Blue home">
          <img src={logoSrc} alt="Agent Blue" className="landing-brand-logo" loading="eager" decoding="async" />
          <span className="landing-brand-copy">
            <span className="landing-brand-title">Agent Blue</span>
            <span className="landing-brand-subtitle">Data assistant for chat teams</span>
          </span>
        </a>

        <div className="landing-nav-actions landing-nav-actions--desktop">
          <Button asChild variant="outline" size="pill">
            <a href="/login">Login</a>
          </Button>
          <Button asChild variant="default" size="pill">
            <a href="/register">Book demo</a>
          </Button>
        </div>

        <div className="landing-topbar-mobile">
          <button
            ref={menuToggleRef}
            type="button"
            className="landing-menu-toggle"
            aria-expanded={mobileMenuOpen}
            aria-controls={LANDING_MOBILE_MENU_ID}
            aria-haspopup="true"
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            onClick={(e) => {
              e.stopPropagation();
              setMobileMenuOpen((open) => !open);
            }}
          >
            <span className="landing-menu-toggle-bars" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>

          {mobileMenuOpen
            ? createPortal(
                <div
                  ref={menuPanelRef}
                  id={LANDING_MOBILE_MENU_ID}
                  className="landing-menu-drawer bp-card"
                  role="region"
                  aria-label="Account actions"
                >
                  <div className="landing-menu-drawer-actions">
                    <Button asChild variant="outline" size="pill" className="landing-menu-drawer-btn">
                      <a href="/login" onClick={() => setMobileMenuOpen(false)}>
                        Login
                      </a>
                    </Button>
                    <Button asChild variant="default" size="pill" className="landing-menu-drawer-btn">
                      <a href="/register" onClick={() => setMobileMenuOpen(false)}>
                        Book demo
                      </a>
                    </Button>
                  </div>
                </div>,
                document.body
              )
            : null}
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero" aria-labelledby="landing-hero-title">
          <article className="landing-hero-content">
            <p className="eyebrow">
              Native in{" "}
              <FontAwesomeIcon icon={faTelegram} className="landing-eyebrow-icon" />
              {" "}Telegram,{" "}
              <FontAwesomeIcon icon={faSlack} className="landing-eyebrow-icon" />
              {" "}Slack
            </p>
            <h1 id="landing-hero-title" className="landing-hero-title">
              <AnimatedText
                text="Your data team, in every conversation."
                immediate
                staggerMs={34}
              />
            </h1>
            <p className="landing-hero-description">
              Answers, charts and dashboards in Slack and Telegram (powered by your dbt models and warehouse).
            </p>

            <div className="landing-hero-actions">
              <Button asChild variant="default" size="pill-lg">
                <a href="/register">Book demo</a>
              </Button>
              <Button asChild variant="outline" size="pill-lg">
                <a href="#onboarding">How it works</a>
              </Button>
            </div>
          </article>

          <aside className="landing-hero-preview" aria-label="Agent Blue in Slack">
            <BlueprintCard interactive contentClassName="landing-chat-content">
              <div className="landing-chat-header">
                <span className="landing-chat-status-dot" />
                <span className="landing-chat-bot-name">Agent Blue</span>
                <span className="landing-chat-platform-badge">
                  <FontAwesomeIcon icon={faSlack} />
                  {" "}Slack
                </span>
              </div>
              <div className="landing-chat-messages">
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`landing-chat-msg landing-chat-msg--${msg.role}`}>
                    {msg.role === "bot" ? (
                      <img src={logoSrc} alt="Agent Blue" className="landing-chat-avatar-logo" />
                    ) : (
                      <div className="landing-chat-user-avatar">
                        <img src={sofiaAvatarSrc} alt="Sofia R." />
                      </div>
                    )}
                    <div className="landing-chat-bubble">
                      <span className={`landing-chat-sender landing-chat-sender--${msg.role}`}>
                        {msg.role === "bot" ? "Agent Blue" : msg.name}
                      </span>
                      <p>{msg.text}</p>
                      {msg.chart && (
                        <div className="landing-chat-chart-badge">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <path d="M7 16l3-4 3 3 3-5" />
                          </svg>
                          {msg.chart}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div className="landing-chat-msg landing-chat-msg--bot">
                  <img src={logoSrc} alt="Agent Blue" className="landing-chat-avatar-logo" />
                  <div className="landing-chat-bubble">
                    <span className="landing-chat-sender landing-chat-sender--bot">Agent Blue</span>
                    <AILoadingState />
                  </div>
                </div>
              </div>
            </BlueprintCard>
          </aside>
        </section>

        <section id="product" className="landing-section" aria-labelledby="landing-product-title">
          <h2 id="landing-product-title" className="landing-section-title">
            Built for teams that work in chat
          </h2>

          <PillarShowcase />
        </section>

        <section id="onboarding" className="landing-section" aria-labelledby="landing-onboarding-title">
          <h2 id="landing-onboarding-title" className="landing-section-title">
            Live in 4 steps
          </h2>

          <OnboardingFlow />
        </section>

        <section id="pricing" className="landing-section" aria-labelledby="landing-pricing-title">
          <h2 id="landing-pricing-title" className="landing-section-title">
            Pricing
          </h2>

          <article className="landing-pricing-soon bp-card">
            <p className="landing-pricing-soon-text">
              Agent Blue is brand new and we're still figuring out the right pricing.
              Reach out and we'll set something up that fits your team.
            </p>
            <Button asChild variant="default" size="pill-lg" className="landing-pricing-cta">
              <a href="mailto:contact@blueprintdata.xyz">Contact us</a>
            </Button>
          </article>
        </section>

        <section id="trust" className="landing-section" aria-labelledby="landing-trust-title">
          <article className="landing-trust-band bp-card">
            <div>
              <h2 id="landing-trust-title" className="landing-section-title landing-trust-title">
                Your data. Your channels. Your answers.
              </h2>
              <p className="landing-trust-description">
                dbt governance and warehouse traceability, built in.
              </p>
            </div>
            <div className="landing-trust-actions">
              <Button asChild variant="default" size="pill-lg">
                <a href="/register">Book demo</a>
              </Button>
              <Button asChild variant="outline" size="pill-lg">
                <a href="/login">Login</a>
              </Button>
            </div>
          </article>
        </section>
      </main>

    </div>

    <footer className="landing-footer">
      <div className="landing-footer-mesh" aria-hidden="true" />

      <div className="landing-footer-inner">
        <div className="landing-footer-left">
          <div className="landing-footer-logo-wrap">
            <div className="landing-footer-logo-glow" aria-hidden="true" />
            <img src={logoSrc} alt="Agent Blue" className="landing-footer-logo" />
          </div>

          <div className="landing-footer-contact-block">
            <p className="landing-footer-contact-label">Contact</p>
            <a href="mailto:contact@blueprintdata.xyz" className="landing-footer-email">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="20" height="16" x="2" y="4" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
              contact@blueprintdata.xyz
            </a>

            <div className="landing-footer-socials">
              <a href="https://www.linkedin.com/company/bpdata/" target="_blank" rel="noopener noreferrer" className="landing-footer-social" aria-label="Follow us on LinkedIn">
                <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                </svg>
              </a>
              <a href="https://x.com/blueprintdata_" target="_blank" rel="noopener noreferrer" className="landing-footer-social" aria-label="Follow us on X">
                <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
                </svg>
              </a>
            </div>
          </div>
        </div>

        <nav className="landing-footer-nav" aria-label="Footer navigation">
          <a href="#product" className="landing-footer-link">Why Agent Blue</a>
          <a href="#onboarding" className="landing-footer-link">Setup</a>
          <a href="#pricing" className="landing-footer-link">Pricing</a>
          <a href="#trust" className="landing-footer-link">Trust</a>
        </nav>
      </div>

      <div className="landing-footer-bottom">
        <span>© {new Date().getFullYear()} Agent Blue · Blueprint Data</span>
      </div>
    </footer>
    </div>
  );
}
