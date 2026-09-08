import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { AppProviders } from "@/providers/app-providers";
import { copy } from "@content/copy";

export const metadata: Metadata = {
  title: copy.site.title,
  description: copy.site.description,
  openGraph: {
    title: copy.site.ogTitle,
    description: copy.site.ogDescription,
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Plex is the reference explorer's typeface; matching it is what makes
            this read as part of the counters family rather than a lookalike. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AppProviders>
          <SiteHeader />
          <main className="mx-auto w-full max-w-[1120px] px-5 pb-24">{children}</main>
        </AppProviders>
      </body>
    </html>
  );
}
