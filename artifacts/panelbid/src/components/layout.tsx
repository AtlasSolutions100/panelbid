import * as React from "react"
import { Link, useLocation } from "wouter"
import { Building2, LayoutDashboard, Settings } from "lucide-react"

import { cn } from "@/lib/utils"
import { SignOutButton } from "@/auth"

interface LayoutProps {
  children: React.ReactNode
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation()

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b bg-card sticky top-0 z-30">
        <div className="flex h-16 items-center px-4 md:px-6">
          <div className="flex items-center gap-2 font-bold text-lg tracking-tight mr-8 text-primary">
            <Building2 className="h-5 w-5" />
            River City Plastics
          </div>
          <nav className="flex items-center gap-6 text-sm font-medium">
            <Link
              href="/"
              className={cn(
                "transition-colors hover:text-foreground/80",
                location === "/" ? "text-foreground" : "text-foreground/60"
              )}
            >
              <span className="flex items-center gap-2">
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </span>
            </Link>
            <Link
              href="/settings"
              className={cn(
                "transition-colors hover:text-foreground/80",
                location === "/settings" ? "text-foreground" : "text-foreground/60"
              )}
            >
              <span className="flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Settings
              </span>
            </Link>
          </nav>
          <div className="ml-auto">
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-[1400px] mx-auto w-full p-4 md:p-8">
        {children}
      </main>
    </div>
  )
}
