import { describe, expect, it } from "vitest";
import { applySiteUrl } from "./siteUrlMeta.js";

const html = `<html><head>
<meta property="og:image" content="/og-image.png" />
<meta name="twitter:image" content="/og-image.png" />
</head><body></body></html>`;

describe("applySiteUrl", () => {
  it("makes share image URLs absolute and adds og:url and canonical", () => {
    const out = applySiteUrl(html, "https://shhsaid.example/");
    expect(out).toContain(
      '<meta property="og:image" content="https://shhsaid.example/og-image.png" />',
    );
    expect(out).toContain(
      '<meta name="twitter:image" content="https://shhsaid.example/og-image.png" />',
    );
    expect(out).toContain(
      '<meta property="og:url" content="https://shhsaid.example/" />',
    );
    expect(out).toContain(
      '<link rel="canonical" href="https://shhsaid.example/" />',
    );
  });

  it("leaves the page unchanged without a site URL", () => {
    expect(applySiteUrl(html, "")).toBe(html);
    expect(applySiteUrl(html, undefined)).toBe(html);
  });
});
