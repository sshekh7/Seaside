"use client"

import * as React from "react"

import { SidebarProvider } from "@/components/ui/sidebar"

export function FixedSidebarProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <SidebarProvider
      open={false}
      onOpenChange={() => {}}
      style={{ "--sidebar-width-icon": "3rem" } as React.CSSProperties}
    >
      {children}
    </SidebarProvider>
  )
}
