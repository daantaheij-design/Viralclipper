"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Discover", icon: "🔥" },
  { href: "/top", label: "Top Clips", icon: "🏆" },
  { href: "/saved", label: "Saved", icon: "📌" },
  { href: "/used", label: "Used", icon: "✅" },
  { href: "/rejected", label: "Rejected", icon: "🗑️" },
  { href: "/sources", label: "Sources", icon: "🔌" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
];

export function NavSidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-surface px-3 py-6">
      <div className="mb-8 px-3">
        <span className="text-lg font-bold tracking-tight text-foreground">
          Viral<span className="text-accent">Clip</span>Finder
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-1">
        {LINKS.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                active
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-surface-2 hover:text-foreground"
              }`}
            >
              <span>{link.icon}</span>
              {link.label}
            </Link>
          );
        })}
      </div>

      <form method="POST" action="/api/auth/logout" className="px-3">
        <button
          type="submit"
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted transition hover:bg-surface-2 hover:text-foreground"
        >
          Log out
        </button>
      </form>
    </nav>
  );
}
