import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { AppSidebar } from "@/components/app-sidebar"
import { FixedSidebarProvider } from "@/components/fixed-sidebar-provider"
import { SidebarInset } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
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
        fontMono.variable,
        "font-sans",
        geist.variable
      )}
      style={{ colorScheme: "dark" }}
    >
      <body>
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
