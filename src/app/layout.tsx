import type { Metadata } from "next";
import { Inter } from "next/font/google";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-[#FAFAFA] font-sans text-[#111111]">
        {children}
      </body>
    </html>
  );
}
