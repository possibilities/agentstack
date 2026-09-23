import type { ReactNode } from "react";
import type { Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={GeistSans.variable}>
      <body className="bg-background font-sans text-foreground">{children}</body>
    </html>
  );
}
