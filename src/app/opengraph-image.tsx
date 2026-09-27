import { ImageResponse } from "next/og";

/**
 * The share card for every route that doesn't define its own: the product's headline set in the brand's own
 * type and colours on white, with the three-node glyph. No photography, no logos, no gradients.
 */
export const alt = "AI Staffing Agency — describe the job, meet your new hire.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#1d1d1f";
const SECONDARY = "#6e6e73";
const BLUE = "#0071e3";

/**
 * Inter is the one typeface the site ships, but next/font only ever downloads it as woff2, which the image
 * renderer cannot read. So the two weights the card uses are fetched once per process from Google Fonts (the
 * same source next/font uses at build time) in plain WOFF, which the renderer does accept, resolved through
 * the stylesheet rather than a pinned file URL so a font version bump doesn't break the card. If the fetch
 * fails — no egress, a timeout — the card renders in the renderer's default sans instead of failing the request.
 */
const INTER_CSS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap";
// A pre-woff2 browser signature makes the stylesheet list plain WOFF sources instead of woff2.
const LEGACY_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.6; rv:5.0) Gecko/20100101 Firefox/5.0";
const FETCH_TIMEOUT_MS = 5_000;

type FontFace = { name: "Inter"; data: ArrayBuffer; weight: 400 | 600; style: "normal" };

let fontsPromise: Promise<FontFace[]> | undefined;

async function fetchFonts(): Promise<FontFace[]> {
  const css = await fetch(INTER_CSS, {
    headers: { "User-Agent": LEGACY_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!css.ok) return [];
  const text = await css.text();
  const faces: FontFace[] = [];
  for (const weight of [400, 600] as const) {
    const block = new RegExp(`font-weight:\\s*${weight};[^}]*?src:\\s*url\\((https://fonts\\.gstatic\\.com/[^)]+)\\)`).exec(text);
    if (!block?.[1]) continue;
    const file = await fetch(block[1], { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!file.ok) continue;
    faces.push({ name: "Inter", data: await file.arrayBuffer(), weight, style: "normal" });
  }
  return faces;
}

function loadFonts(): Promise<FontFace[]> {
  fontsPromise ??= fetchFonts().catch(() => []);
  return fontsPromise.then((faces) => {
    // Don't cache a miss: a transient network failure shouldn't pin the fallback font for the process's life.
    if (faces.length === 0) fontsPromise = undefined;
    return faces;
  });
}

export default async function OpengraphImage() {
  const fonts = await loadFonts();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#ffffff",
          padding: "72px 80px",
          color: INK,
          fontFamily: fonts.length > 0 ? "Inter" : undefined,
          fontWeight: 400,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
          <svg width="44" height="44" viewBox="0 0 24 24">
            <path
              d="M12 9.2v3.1m0 0-4.6 3.2m4.6-3.2 4.6 3.2"
              stroke={INK}
              strokeOpacity="0.45"
              strokeWidth="1.6"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="12" cy="6.4" r="2.9" fill={INK} />
            <circle cx="6.4" cy="17.2" r="2.5" fill={INK} fillOpacity="0.72" />
            <circle cx="17.6" cy="17.2" r="2.5" fill={INK} fillOpacity="0.72" />
          </svg>
          <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}>AI Staffing Agency</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 104, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.02 }}>
            Describe the job.
          </div>
          <div style={{ fontSize: 104, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.02 }}>
            Meet your new hire.
          </div>
          <div style={{ marginTop: 28, fontSize: 36, color: SECONDARY, maxWidth: 1000, lineHeight: 1.3 }}>
            Scope the work, hire an AI worker for it, review every deliverable.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: 26, color: SECONDARY }}>
          <div style={{ display: "flex", width: 12, height: 12, borderRadius: 999, backgroundColor: BLUE }} />
          <div style={{ display: "flex" }}>Job → Worker → Runs → Deliverables → Review</div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
