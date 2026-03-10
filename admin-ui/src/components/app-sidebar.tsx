import { NavLink } from "react-router-dom";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu } from "./ui/sidebar";

type AppSidebarProps = {
  username?: string;
  method?: string;
  onLogout: () => void;
};

function StatusBadge({ label, tone }: { label: string; tone?: string }) {
  return <span className={`status-badge ${tone ?? "neutral"}`}>{label}</span>;
}

function NavItem({ to, children }: { to: string; children: string }) {
  return (
    <NavLink className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`} to={to} end={to === "/"}>
      {children}
    </NavLink>
  );
}

export function AppSidebar({ username, method, onLogout }: AppSidebarProps) {
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="sidebar-brand">
          <span className="eyebrow">Operator console</span>
          <h1>Agent Blue Admin</h1>
          <p>Secure tenant operations, Slack bot control, and execution visibility.</p>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          <NavItem to="/">Overview</NavItem>
          <NavItem to="/new-tenant">New Tenant</NavItem>
          <NavItem to="/tenants">Tenants</NavItem>
          <NavItem to="/conversations">Conversations</NavItem>
          <NavItem to="/slack-bot">Slack Bot</NavItem>
          <NavItem to="/telegram-bot">Telegram Bot</NavItem>
          <NavItem to="/settings">Settings</NavItem>
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <div className="session-chip">
          <span>{username}</span>
          <StatusBadge label={method ?? "session"} tone="accent" />
        </div>
        <button className="secondary-button" onClick={onLogout}>
          Log out
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
