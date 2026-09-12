import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { DevErrorReporter } from "@/components/dev-error-reporter";
import { FaviconAnimator } from "@/components/favicon-animator";
import { AppProviders } from "@/providers/app-providers";
import { copy } from "@content/copy";
import { SITE_URL } from "@/lib/constants";

export const metadata: Metadata = {
  // Every og:image below is written as a site-relative path; a crawler cannot
  // resolve one, so Next needs a base to make them absolute. Without it the
  // image tag is emitted relative and chat clients silently show no preview,
  // which is what counters.fun did until now.
  metadataBase: new URL(SITE_URL),
  title: copy.site.title,
  description: copy.site.description,
  openGraph: {
    title: copy.site.ogTitle,
    description: copy.site.ogDescription,
    type: "website",
    url: SITE_URL,
    siteName: copy.site.title,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: copy.site.ogImageAlt }],
  },
  twitter: {
    // The whole point of a preview is the picture; `summary` crops it to a
    // thumbnail beside the text.
    card: "summary_large_image",
    title: copy.site.ogTitle,
    description: copy.site.ogDescription,
    images: [{ url: "/og.png", alt: copy.site.ogImageAlt }],
  },
  // The FUN wordmark. The SVG's gradient slides (SMIL); see FaviconAnimator
  // for browsers that rasterise favicons once.
  icons: {
    icon: [
      { url: "/fun-icon.svg", type: "image/svg+xml" },
      { url: "/fun-icon-32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: "/fun-apple-180.png",
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
          {/* Local runs only: collects this tab's unhandled failures into
              .logs/errors.log, where the server writes its own. */}
          {process.env.NODE_ENV !== "production" && <DevErrorReporter />}
          <FaviconAnimator />
          <SiteHeader />
          <main className="mx-auto w-full max-w-[1120px] px-5 pb-24">{children}</main>
        </AppProviders>
      </body>
    </html>
  );
}
