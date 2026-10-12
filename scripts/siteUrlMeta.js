/**
 * Social previews need absolute URLs, but the deploy domain is chosen at
 * build time. When VITE_SITE_URL is set, rewrite the share image paths in
 * index.html to absolute URLs and add og:url and a canonical link.
 */

/**
 * @param {string} html
 * @param {string | undefined} siteUrl
 */
export function applySiteUrl(html, siteUrl) {
  if (!siteUrl) return html;
  const base = siteUrl.replace(/\/+$/, "");
  return html
    .replace(/content="\/og-image\.png"/g, `content="${base}/og-image.png"`)
    .replace(
      "</head>",
      `<meta property="og:url" content="${base}" />\n` +
        `<link rel="canonical" href="${base}" />\n</head>`,
    );
}

/**
 * @param {string | undefined} siteUrl
 * @returns {import('vite').Plugin}
 */
export function siteUrlMeta(siteUrl) {
  return {
    name: "site-url-meta",
    transformIndexHtml: (html) => applySiteUrl(html, siteUrl),
  };
}
