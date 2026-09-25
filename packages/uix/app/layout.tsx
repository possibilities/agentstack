import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { brandIconUrl } from "@/lib/brand";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "AgentStack",
  description: "Local AgentStack links and running bots.",
  icons: {
    icon: { url: brandIconUrl, type: "image/svg+xml" },
    apple: "/brand/light-mode/web/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable, geistMono.variable)}>
      <body>
        <TooltipProvider delay={300}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
