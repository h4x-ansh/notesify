"use client";

import { Home, NotebookPen, Settings } from "lucide-react";
import styles from "./AppShell.module.css";
import type { Screen } from "./AppShell";

interface BottomNavProps {
  active: Screen;
  onNavigate: (screen: Screen) => void;
}

const TABS: { screen: Screen; label: string; Icon: typeof Home }[] = [
  { screen: "home", label: "Home", Icon: Home },
  { screen: "generate", label: "New Notes", Icon: NotebookPen },
  { screen: "settings", label: "Settings", Icon: Settings },
];

/**
 * Mobile-appropriate bottom tab bar - thumb-reachable, fixed to the
 * viewport bottom (see AppShell.module.css's .navBar for the safe-area
 * inset padding, needed under Android's gesture nav bar). Icons from
 * lucide-react, styled with the ink/paper palette via currentColor
 * (--pencil-grey inactive, --marker-red active - see .navItem/.navItemActive)
 * rather than a default Material blue.
 */
export default function BottomNav({ active, onNavigate }: BottomNavProps) {
  return (
    <nav className={styles.navBar}>
      {TABS.map(({ screen, label, Icon }) => {
        const isActive = active === screen;
        return (
          <button
            key={screen}
            type="button"
            className={`${styles.navItem} ${isActive ? styles.navItemActive : ""}`}
            onClick={() => onNavigate(screen)}
            aria-current={isActive ? "page" : undefined}
          >
            <Icon size={22} strokeWidth={isActive ? 2.4 : 2} />
            <span className={styles.navLabel}>{label}</span>
            {isActive && <span className={styles.navDot} />}
          </button>
        );
      })}
    </nav>
  );
}
