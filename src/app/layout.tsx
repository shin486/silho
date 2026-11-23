import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { OpeningAnimation } from "@/components/OpeningAnimation";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "SILHO — Digital Wardrobe & Cost-Per-Wear Ledger",
  description:
    "Minimalist digital wardrobe, transparent garment cutouts, cost-per-wear tracking, and fit composition.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F9F8F6",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-[#F9F8F6] font-sans text-[#0E0E0E]">
        <OpeningAnimation />
        {children}
      </body>
    </html>
  );
}
