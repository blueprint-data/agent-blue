import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

const SIDEBAR_KEYBOARD_SHORTCUT = "b";
const MOBILE_BREAKPOINT_PX = 768;

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function useIsMobile(): boolean {
  const getInitial = () =>
    typeof window !== "undefined" ? window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches : false;

  const [isMobile, setIsMobile] = useState(getInitial);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

type SidebarContextValue = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (value: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (value: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  className,
  style,
  children
}: {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const isMobile = useIsMobile();
  const isControlled = controlledOpen !== undefined;
  const [openUncontrolled, setOpenUncontrolled] = useState(defaultOpen);
  const open = isControlled ? controlledOpen : openUncontrolled;

  const setOpen = useCallback(
    (value: boolean) => {
      if (!isControlled) {
        setOpenUncontrolled(value);
      }
      onOpenChange?.(value);
    },
    [isControlled, onOpenChange]
  );

  const [openMobile, setOpenMobile] = useState(false);

  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  const toggleSidebar = useCallback(() => {
    if (isMobileRef.current) {
      setOpenMobile((o) => !o);
    } else {
      setOpen(!open);
    }
  }, [open, setOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key !== SIDEBAR_KEYBOARD_SHORTCUT || !(e.metaKey || e.ctrlKey)) return;
      const t = e.target;
      if (t instanceof HTMLElement) {
        if (t.isContentEditable) return;
        if (t.closest("input, textarea, select, [data-sidebar-ignore-shortcut]")) return;
      }
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  useEffect(() => {
    if (!isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile]);

  const state: "expanded" | "collapsed" = open ? "expanded" : "collapsed";

  const value = useMemo(
    () => ({
      state,
      open,
      setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar
    }),
    [state, open, setOpen, openMobile, isMobile, toggleSidebar]
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        className={cn("sidebar-provider", className)}
        style={style}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used inside SidebarProvider.");
  }
  return context;
}

export type SidebarProps = {
  side?: "left" | "right";
  collapsible?: "offcanvas" | "icon" | "none";
  className?: string;
  children: React.ReactNode;
};

export function Sidebar({ side = "left", collapsible = "offcanvas", className, children }: SidebarProps) {
  const { isMobile, open, openMobile, setOpenMobile, state } = useSidebar();

  if (collapsible === "none") {
    return (
      <aside
        data-slot="sidebar"
        data-side={side}
        data-state="expanded"
        data-collapsible="none"
        className={cn("sidebar sidebar-fixed", className)}
      >
        {children}
      </aside>
    );
  }

  if (isMobile) {
    return (
      <>
        <button
          type="button"
          className={cn("sidebar-mobile-backdrop", openMobile && "sidebar-mobile-backdrop-visible")}
          aria-label="Close menu"
          aria-hidden={!openMobile}
          tabIndex={openMobile ? 0 : -1}
          onClick={() => setOpenMobile(false)}
        />
        <aside
          data-slot="sidebar"
          data-side={side}
          data-mobile="true"
          data-state={openMobile ? "expanded" : "collapsed"}
          aria-hidden={!openMobile}
          inert={!openMobile ? true : undefined}
          className={cn("sidebar sidebar-mobile-panel", openMobile && "sidebar-mobile-panel-open", className)}
        >
          {children}
        </aside>
      </>
    );
  }

  return (
    <aside
      data-collapsible={collapsible}
      data-slot="sidebar"
      data-side={side}
      data-state={state}
      inert={!open ? true : undefined}
      className={cn("sidebar sidebar-fixed sidebar-desktop-offcanvas", !open && "sidebar-desktop-hidden", className)}
    >
      {children}
    </aside>
  );
}

export function SidebarHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div data-slot="sidebar-header" className={cn("sidebar-header", className)}>
      {children}
    </div>
  );
}

export function SidebarContent({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div data-slot="sidebar-content" className={cn("sidebar-content", className)}>
      {children}
    </div>
  );
}

export function SidebarFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div data-slot="sidebar-footer" className={cn("sidebar-footer", className)}>
      {children}
    </div>
  );
}

export function SidebarInset({ className, children }: { className?: string; children: React.ReactNode }) {
  const { open, isMobile } = useSidebar();
  return (
    <section
      data-slot="sidebar-inset"
      className={cn("sidebar-inset", !isMobile && open && "sidebar-inset-offset", className)}
    >
      {children}
    </section>
  );
}

function PanelLeftIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

export function SidebarTrigger({ className }: { className?: string }) {
  const { toggleSidebar, open, isMobile, openMobile } = useSidebar();
  const expanded = isMobile ? openMobile : open;
  return (
    <button
      type="button"
      data-slot="sidebar-trigger"
      className={cn("sidebar-trigger", className)}
      onClick={toggleSidebar}
      aria-expanded={expanded}
      aria-label={expanded ? "Close sidebar" : "Open sidebar"}
    >
      <PanelLeftIcon />
      <span className="sidebar-trigger-label">{expanded ? "Hide menu" : "Show menu"}</span>
    </button>
  );
}

export function SidebarMenu({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <ul data-slot="sidebar-menu" className={cn("sidebar-nav sidebar-menu-list", className)}>
      {children}
    </ul>
  );
}

export function SidebarMenuItem({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <li data-slot="sidebar-menu-item" className={cn("sidebar-menu-item", className)}>
      {children}
    </li>
  );
}
