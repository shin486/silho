import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { OpeningAnimation } from "@/components/OpeningAnimation";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ViewTransitionProvider } from "@/components/ViewTransitionProvider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "SILHO — Swiss Editorial Wardrobe OS",
  description:
    "Monochrome digital wardrobe OS, transparent garment cutouts, cost-per-wear telemetry, and editorial fit studio.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ECECEB",
};

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('silho-theme');if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');document.documentElement.style.colorScheme='dark';var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('content','#1E2022');}}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-[var(--bg-viewport)] font-sans text-[var(--ink-primary)]">
        <ThemeProvider>
          <ViewTransitionProvider>
            <OpeningAnimation />
            {children}
          </ViewTransitionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
