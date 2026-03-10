import React, { createContext, useContext, useMemo, useState } from "react";

type SidebarContextValue = {
  open: boolean;
  setOpen: (value: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function SidebarProvider({
  defaultOpen = true,
  children
}: {
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const value = useMemo(
    () => ({
      open,
      setOpen,
      toggleSidebar: () => setOpen((current) => !current)
    }),
    [open]
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used inside SidebarProvider.");
  }
  return context;
}

export function Sidebar({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { open } = useSidebar();
  return (
    <aside data-slot="sidebar" data-state={open ? "expanded" : "collapsed"} className={cn("sidebar", className)}>
      {children}
    </aside>
  );
}

export function SidebarHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("sidebar-header", className)}>{children}</div>;
}

export function SidebarContent({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("sidebar-content", className)}>{children}</div>;
}

export function SidebarFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("sidebar-footer", className)}>{children}</div>;
}

export function SidebarInset({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section data-slot="sidebar-inset" className={cn("sidebar-inset", className)}>
      {children}
    </section>
  );
}

export function SidebarTrigger({ className }: { className?: string }) {
  const { toggleSidebar, open } = useSidebar();
  return (
    <button type="button" className={cn("sidebar-trigger", className)} onClick={toggleSidebar} aria-label="Toggle sidebar">
      {open ? "Hide menu" : "Show menu"}
    </button>
  );
}

export function SidebarMenu({ className, children }: { className?: string; children: React.ReactNode }) {
  return <nav className={cn("sidebar-nav", className)}>{children}</nav>;
}
