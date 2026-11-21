import type { Metadata } from "next";
import { siteMetadata } from "@/brand/brand";
import {
  Architects_Daughter,
  JetBrains_Mono,
  Newsreader,
  Plus_Jakarta_Sans,
} from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VercelAnalytics } from "./vercel-analytics";
import "./globals.css";

const plusJakarta = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const newsreader = Newsreader({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

const architectsDaughter = Architects_Daughter({
  variable: "--font-sketch",
  subsets: ["latin"],
  weight: ["400"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = siteMetadata;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${plusJakarta.variable} ${newsreader.variable} ${architectsDaughter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden selection:bg-[#D94E28]/20">
        <TooltipProvider delay={260}>{children}</TooltipProvider>
        <VercelAnalytics />
      </body>
    </html>
  );
}
