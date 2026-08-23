import type { Metadata } from "next";
import { ClerkProvider, SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Geist Sans and Mono, as measured from the reference design.
const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "wapi",
  description: "WhatsApp REST API dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={`${sans.variable} ${mono.variable}`}>
          <header className="border-b border-[var(--border)]">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
              <a href="/" className="font-mono text-sm tracking-[0.1em] uppercase">
                wapi
              </a>
              <nav className="flex items-center gap-5 text-sm">
                <a
                  href="https://api.wapi.crafter.run/docs"
                  className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  API reference
                </a>
                <SignedIn>
                  <UserButton />
                </SignedIn>
                <SignedOut>
                  <SignInButton mode="modal">
                    <button className="rounded-[var(--radius)] bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)]">
                      Sign in
                    </button>
                  </SignInButton>
                </SignedOut>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
