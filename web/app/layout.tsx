import { JetBrains_Mono } from "next/font/google"

import "./globals.css"
import { AppSidebar } from "@/components/app-sidebar"
import { FixedSidebarProvider } from "@/components/fixed-sidebar-provider"
import { SidebarInset } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-sans",
})

const jetbrainsMonoCode = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={cn(
        "dark antialiased",
        jetbrainsMono.variable,
        jetbrainsMonoCode.variable,
        "font-sans"
      )}
      style={{ colorScheme: "dark" }}
    >
      <body suppressHydrationWarning>
        <TooltipProvider>
          <FixedSidebarProvider>
            <AppSidebar />
            <SidebarInset>{children}</SidebarInset>
          </FixedSidebarProvider>
        </TooltipProvider>
      </body>
    </html>
  )
}
