import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const metadataBase = host ? new URL(`${protocol}://${host}`) : undefined;

  return {
    metadataBase,
    title: "OddPulse — Verifiable Odds Movement Intelligence",
    description:
      "Authenticated TxLINE evidence with device-local audit history and a clearly separated deterministic movement replay.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
      title: "OddPulse — Verifiable Odds Movement Intelligence",
      description:
        "Authenticated TxLINE evidence with device-local audit history and a clearly separated deterministic movement replay.",
      images: [
        {
          url: "/og.png",
          width: 1744,
          height: 900,
          alt: "OddPulse authenticated evidence and deterministic replay",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "OddPulse — Verifiable Odds Movement Intelligence",
      description:
        "Authenticated TxLINE evidence with device-local audit history and a clearly separated deterministic movement replay.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
