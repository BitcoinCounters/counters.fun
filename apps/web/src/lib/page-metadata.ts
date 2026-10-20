import type { Metadata } from "next";
import { copy } from "@content/copy";
import { SITE_URL } from "@/lib/constants";

/**
 * A page's head: its own title, a canonical URL, and an og:url that names the
 * page rather than the site.
 *
 * Next merges metadata shallowly, so a page that sets `openGraph` at all
 * replaces the layout's whole block — image included. That is why the site's
 * og fields are repeated here rather than only the url.
 *
 * The canonical is what makes `www.`, the query-string variants of `/` and
 * any other alias resolve to one URL for a search engine.
 */
export function pageMetadata(path: string, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description: copy.site.ogDescription,
      type: "website",
      url: `${SITE_URL}${path === "/" ? "" : path}`,
      siteName: copy.site.title,
      images: [{ url: "/og.png", width: 1200, height: 630, alt: copy.site.ogImageAlt }],
    },
  };
}
