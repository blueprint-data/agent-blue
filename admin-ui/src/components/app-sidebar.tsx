import { NavLink } from "react-router-dom";
import logoSrc from "@/assets/logo.png";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem
} from "./ui/sidebar";

type AppSidebarProps = {
  username?: string;
  method?: string;
  isSuperadmin?: boolean;
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

export function AppSidebar({ username, method, isSuperadmin = true, onLogout }: AppSidebarProps) {
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="sidebar-brand">
          <div className="sidebar-brand-row">
            <div className="sidebar-brand-mark" aria-hidden>
              <img src={logoSrc} alt="Agent Blue" />
            </div>
            <div className="sidebar-brand-text">
              <span className="eyebrow sidebar-brand-eyebrow">Console</span>
              <h1 className="sidebar-brand-title">Agent Blue</h1>
            </div>
          </div>
          <p className="sidebar-brand-sub">Operator admin</p>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <p className="sidebar-nav-label">Navigation</p>
        <SidebarMenu>
          <SidebarMenuItem>
            <NavItem to="/">Overview</NavItem>
          </SidebarMenuItem>
          {isSuperadmin ? (
            <SidebarMenuItem>
              <NavItem to="/new-tenant">New Tenant</NavItem>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <NavItem to="/tenants">Tenants</NavItem>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <NavItem to="/conversations">Conversations</NavItem>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <NavItem to="/schedules">Schedules</NavItem>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <NavItem to="/telegram-routing">Telegram routing</NavItem>
          </SidebarMenuItem>
          {isSuperadmin ? (
            <SidebarMenuItem>
              <NavItem to="/settings">Settings</NavItem>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <div className="session-chip">
          <span>{username}</span>
          <StatusBadge label={method ?? "session"} tone="accent" />
        </div>
        <button type="button" className="sidebar-logout-button" onClick={onLogout}>
          Log out
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
