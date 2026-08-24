import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "wapi — WhatsApp over HTTP",
  description:
    "Self-hosted WhatsApp REST API. Link a number, get an API key, send and receive messages over HTTP.",
};

/**
 * The root layout deliberately renders no chrome.
 *
 * The landing page and the dashboard want different navigation, and a shared header forced
 * both into a compromise. Each surface brings its own via <AppNav /> or its own <Nav />.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={`${sans.variable} ${mono.variable}`}>{children}</body>
      </html>
    </ClerkProvider>
  );
}
