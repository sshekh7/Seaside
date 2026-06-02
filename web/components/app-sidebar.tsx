"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Database, Flask, FlowArrow, Info, MapTrifold, Robot } from "@phosphor-icons/react/dist/ssr"

import { Logo } from "@/components/logo"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

const navItems = [
  { title: "Map", href: "/map", icon: MapTrifold },
  { title: "Database", href: "/database", icon: Database },
  { title: "Experiments", href: "/experiments", icon: Flask },
  { title: "Pipeline", href: "/pipeline", icon: FlowArrow },
  { title: "Create agent", href: "/agents/new", icon: Robot },
  { title: "About", href: "/about", icon: Info },
] as const

export function AppSidebar() {
  const pathname = usePathname()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="items-center p-2">
        <Link
          href="/"
          aria-label="Home"
          className="flex h-8 w-8 items-center justify-center rounded-md bg-foreground text-background"
        >
          <Logo />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu className="items-center gap-1 p-2">
          {navItems.map(({ title, href, icon: Icon }) => {
            const isActive =
              pathname === href || pathname.startsWith(`${href}/`)
            return (
              <SidebarMenuItem key={href} className="w-auto">
                <SidebarMenuButton
                  isActive={isActive}
                  tooltip={title}
                  className="h-9 w-9 justify-center !p-0"
                  render={<Link href={href} aria-label={title} />}
                >
                  <Icon size={20} weight={isActive ? "fill" : "regular"} />
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarContent>
    </Sidebar>
  )
}
