import { faSlack, faTelegram } from "@fortawesome/free-brands-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import logoSrc from "@/assets/logo.png";
import sofiaAvatarSrc from "@/assets/sofia.png";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { AnimatedText } from "@/components/ui/animated-text";
import { BlueprintCard } from "@/components/ui/blueprint-card";
import { Button } from "@/components/ui/button";
import SoftAurora from "@/components/ui/soft-aurora";
import AILoadingState from "./AILoadingState";
import "./landing.css";

type ChatRole = "user" | "bot";
interface ChatMessage {
  role: ChatRole;
  name?: string;
  text: string;
  chart?: string;
}

const plans = [
  {
    name: "Trial",
    price: "$0",
    tagline: "Try Agent Blue with your own data, no credit card required",
    featured: false,
    features: [
      { label: "AI provider", value: "GPT-4o mini" },
      { label: "Queries per month", value: "50" },
      { label: "Workspaces", value: "1" },
      { label: "Scheduled reports", value: "None" },
      { label: "Dashboard exports", value: "None" },
      { label: "Customization", value: "Standard" },
      { label: "Support", value: "Community" }
    ]
  },
  {
    name: "Pro",
    price: "$150",
    tagline: "For data teams that need real answers, every day",
    featured: true,
    features: [
      { label: "AI provider", value: "GPT-4o / Claude Sonnet" },
      { label: "Queries per month", value: "1,000" },
      { label: "Workspaces", value: "2" },
      { label: "Scheduled reports", value: "Up to 20" },
      { label: "Dashboard exports", value: "Full" },
      { label: "Customization", value: "Custom dbt models" },
      { label: "Support", value: "Priority email" }
    ]
  },
  {
    name: "Enterprise",
    price: "Custom",
    tagline: "For orgs with advanced governance requirements",
    featured: false,
    features: [
      { label: "AI provider", value: "Your choice" },
      { label: "Queries per month", value: "Unlimited" },
      { label: "Workspaces", value: "Unlimited" },
      { label: "Scheduled reports", value: "Unlimited" },
      { label: "Dashboard exports", value: "Full + white-label" },
      { label: "Customization", value: "Full custom" },
      { label: "Support", value: "Dedicated + SLA" }
    ]
  }
];

const pillars = [
  {
    title: "Works inside your team's chat",
    description:
      "No new tool, no dashboard. Ask Agent Blue directly in Telegram or Slack. Your team works where they already are."
  },
  {
    title: "Answers, charts and dashboards",
    description:
      "Every response is backed by your dbt models and SQL guardrails. Agent Blue sends text answers, charts, and full dashboards directly to your channel."
  },
  {
    title: "Scheduled reports, delivered to your channel",
    description:
      "Declare analytical schedules for your reports. Agent Blue sends structured insights at the cadence your team needs. No manual pulls, no bottlenecks."
  },
  {
    title: "Governance without friction",
    description:
      "Channel-level permissions and role-based access mean every team gets the right data without slowing anyone down."
  }
];

const onboardingSteps = [
  {
    title: "Connect the bot",
    description: "Add Agent Blue to your Slack workspace or Telegram group in minutes."
  },
  {
    title: "Link your data stack",
    description: "Connect your dbt repo and data warehouse. Agent Blue validates context automatically."
  },
  {
    title: "Set access rules",
    description: "Configure channel permissions and role-based data access for each team."
  },
  {
    title: "Your team asks, Agent Blue answers",
    description: "Natural language questions get traceable, actionable answers. 24/7, no analyst required."
  }
];


const proofPoints = [
  { label: "Available in your chat", value: 24, suffix: "/7" },
  { label: "Less analytics bottleneck", value: 68, suffix: "%" },
  { label: "Faster strategic answers", value: 3, suffix: "x" }
];

const chatMessages: ChatMessage[] = [
  { role: "user", name: "Sofia R.", text: "What's driving churn in our highest-value cohort this quarter?" },
  {
    role: "bot",
    text: "High-value churn is up 1.8pp. Top signal: customers who downgraded in month 4 have 3x higher 90-day churn. LTV impact is estimated at $420K ARR.",
    chart: "churn_by_cohort · LTV risk breakdown"
  },
  { role: "user", name: "Sofia R.", text: "Show me the full revenue breakdown by acquisition channel" }
];

export default function LandingPage() {
  return (
    <>
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

      <header className="landing-topbar bp-card" aria-label="Primary navigation">
        <a className="landing-brand" href="/" aria-label="Agent Blue home">
          <img src={logoSrc} alt="Agent Blue" className="landing-brand-logo" loading="eager" decoding="async" />
          <span className="landing-brand-copy">
            <span className="landing-brand-title">Agent Blue</span>
            <span className="landing-brand-subtitle">Data assistant for chat teams</span>
          </span>
        </a>

        <nav className="landing-nav" aria-label="Product sections">
          <a href="#product">Why Agent Blue</a>
          <a href="#onboarding">Setup</a>
          <a href="#pricing">Get started</a>
          <a href="#trust">Trust</a>
        </nav>

        <div className="landing-nav-actions">
          <Button asChild variant="outline" size="pill">
            <a href="/login">Admin login</a>
          </Button>
          <Button asChild variant="default" size="pill">
            <a href="/register">Book demo</a>
          </Button>
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
                text="Your data team in every conversation. Answers, charts and dashboards without leaving the chat."
                immediate
                staggerMs={34}
              />
            </h1>
            <p className="landing-hero-description">
              Agent Blue connects to your dbt models and data warehouse, then delivers answers, charts, and dashboards
              directly in Telegram or Slack. No GUI, no context switching.
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

        <section className="landing-proof-strip" aria-label="Impact indicators">
          {proofPoints.map((item) => (
            <BlueprintCard key={item.label} title={item.label}>
              <p className="landing-proof-value">
                <AnimatedNumber end={item.value} suffix={item.suffix} />
              </p>
            </BlueprintCard>
          ))}
        </section>

        <section id="product" className="landing-section" aria-labelledby="landing-product-title">
          <h2 id="landing-product-title" className="landing-section-title">
            Built for teams that work in chat, not dashboards
          </h2>
          <p className="landing-section-description">
            Strategic data answers where decisions actually happen: in the conversation, not a separate tool.
          </p>

          <div className="landing-pillar-grid">
            {pillars.map((card) => (
              <BlueprintCard key={card.title} title={card.title} description={card.description} interactive />
            ))}
          </div>
        </section>

        <section id="onboarding" className="landing-section" aria-labelledby="landing-onboarding-title">
          <h2 id="landing-onboarding-title" className="landing-section-title">
            Live in your team's chat in 4 steps
          </h2>
          <p className="landing-section-description">
            From zero to 24/7 data answers in your channels. No engineering sprint required.
          </p>

          <div className="landing-journey-grid">
            {onboardingSteps.map((step, index) => (
              <BlueprintCard
                key={step.title}
                className="landing-journey-card"
                title={
                  <span className="landing-step-title">
                    <span className="landing-step-index">{index + 1}</span>
                    <span>{step.title}</span>
                  </span>
                }
                description={step.description}
                interactive
              />
            ))}
          </div>
        </section>

        <section id="pricing" className="landing-section" aria-labelledby="landing-pricing-title">
          <h2 id="landing-pricing-title" className="landing-section-title">
            Simple, transparent pricing
          </h2>
          <p className="landing-section-description">
            Every plan includes Slack and Telegram integration, dbt context, and warehouse connectivity.
          </p>

          <div className="landing-pricing-grid">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`landing-pricing-card bp-card${plan.featured ? " landing-pricing-card--featured" : ""}`}
              >
                {plan.featured && <span className="landing-pricing-badge">Most popular</span>}
                <div className="landing-pricing-header">
                  <h3 className="landing-pricing-name">{plan.name}</h3>
                  <div className="landing-pricing-price">
                    <span className="landing-pricing-amount">{plan.price}</span>
                    {plan.price !== "Custom" && <span className="landing-pricing-period">/mo</span>}
                  </div>
                  <p className="landing-pricing-tagline">{plan.tagline}</p>
                </div>
                <ul className="landing-pricing-features">
                  {plan.features.map((f) => (
                    <li key={f.label} className="landing-pricing-feature">
                      <span className="landing-pricing-feature-label">{f.label}</span>
                      <span className="landing-pricing-feature-value">{f.value}</span>
                    </li>
                  ))}
                </ul>
                <Button asChild variant={plan.featured ? "default" : "outline"} size="pill" className="landing-pricing-cta">
                  <a href="mailto:hello@blueprintdata.ai">Write to us</a>
                </Button>
              </div>
            ))}
          </div>
          <p className="landing-pricing-note">
            Not sure which plan fits? Write to us and we will set it up together.
          </p>
        </section>

        <section id="trust" className="landing-section" aria-labelledby="landing-trust-title">
          <article className="landing-trust-band bp-card">
            <div>
              <h2 id="landing-trust-title" className="landing-section-title landing-trust-title">
                Your data. Your channels. Your answers.
              </h2>
              <p className="landing-trust-description">
                Agent Blue runs where your team already works: Slack and Telegram. With dbt governance and
                warehouse traceability built in.
              </p>
            </div>
            <div className="landing-trust-actions">
              <Button asChild variant="default" size="pill-lg">
                <a href="/register">Book demo</a>
              </Button>
              <Button asChild variant="outline" size="pill-lg">
                <a href="/login">Admin login</a>
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
    </>
  );
}
