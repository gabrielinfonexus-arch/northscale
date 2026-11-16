/**
 * Demo dataset generator. Produces internally consistent data:
 *  - ad-level rows roll up exactly to ad set → campaign → account rows
 *  - breakdown rows split campaign-day totals (spend exact, counts via largest remainder)
 *  - Shopify orders are driven by ad-platform purchases (platforms over-report ~25–40%)
 *  - one USD Meta account belongs to a BRL client, to exercise FX conversion
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { Rng, apportion, round2 } from "./rng";

type DB = InstanceType<typeof PrismaClient>;
type Plat = "META" | "GOOGLE";

// ───────────────────────── date helpers (UTC calendar days) ─────────────────────────
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s + "T00:00:00Z") + n * DAY));
const asDate = (s: string) => new Date(s + "T00:00:00Z");
const dowOf = (s: string) => (new Date(s + "T00:00:00Z").getUTCDay() + 6) % 7; // 0=Mon
function todayIn(tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function hourFractionIn(tz: string) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return Math.max(0.08, h / 24);
}

// ───────────────────────── config types ─────────────────────────
interface AdDef {
  id: string;
  name: string;
  type: "IMAGE" | "VIDEO" | "CAROUSEL" | "TEXT";
  headline: string;
  body: string;
  landing: string;
  perf: number; // conversion multiplier
  w: number; // spend weight
  ctr?: number;
  hook?: number;
  hold?: number;
  status?: string;
  review?: string;
}
interface AdsetDef {
  id: string;
  name: string;
  w: number;
  ads: AdDef[];
  keywords?: string[];
}
interface CampaignDef {
  id: string;
  name: string;
  objective: string;
  type: string;
  prospecting: boolean;
  share: number;
  roasMult: number;
  leadGen?: boolean;
  searchTerms?: string[];
  adsets: AdsetDef[];
}
interface AccountDef {
  platform: Plat;
  externalId: string;
  name: string;
  currency: string;
  timezone: string;
  dailySpend: number; // account currency
  cpm: number;
  ctr: number;
  cvr: number; // purchases / click
  atcRate: number; // atc / click
  aov: number; // account currency
  trackFunnel: boolean; // false → ATC/IC not provided ("—")
  countries: [string, number][];
  campaigns: CampaignDef[];
  disruptions?: { offset: number; spendMult: number; convMult?: number }[];
}
interface Product {
  id: string;
  title: string;
  price: number;
  cost: number | null;
  pop: number;
}
interface ClientDef {
  name: string;
  slug: string;
  currency: string;
  timezone: string;
  margin: number;
  seed: number;
  accounts: AccountDef[];
  shop: {
    domain: string;
    name: string;
    organicOrders: number;
    attributionDeflator: number; // real orders per platform-reported purchase
    newShare: number;
    freeShippingOver: number;
    shippingFee: number;
    taxRate: number;
    feePct: number;
    feeFixed: number;
    codes: { code: string; pct: number; p: number; newOnly?: boolean }[];
    promoCode: { code: string; pct: number };
    products: Product[];
  };
  other: { source: string; daily: number; aov: number; dow?: number }[];
  promos: { offset: number; len: number; spend: number; conv: number; title: string; category: string }[];
  notes: { offset: number; title: string; description: string; category: string }[];
}

// ───────────────────────── reusable segment definitions ─────────────────────────
const AGES: [string, number, number][] = [
  // value, spend weight, performance
  ["18-24", 0.12, 0.6],
  ["25-34", 0.3, 1.0],
  ["35-44", 0.26, 1.2],
  ["45-54", 0.17, 1.15],
  ["55-64", 0.1, 0.95],
  ["65+", 0.05, 0.7],
];
const GENDERS_META: [string, number, number][] = [
  ["female", 0.68, 1.1],
  ["male", 0.29, 0.8],
  ["unknown", 0.03, 0.6],
];
const GENDERS_GOOGLE: [string, number, number][] = [
  ["Female", 0.6, 1.1],
  ["Male", 0.32, 0.85],
  ["Undetermined", 0.08, 0.8],
];
const PLACEMENTS: [string, number, number][] = [
  ["Facebook · Feed", 0.24, 1.15],
  ["Instagram · Feed", 0.22, 1.1],
  ["Instagram · Stories", 0.16, 0.9],
  ["Instagram · Reels", 0.17, 0.95],
  ["Facebook · Reels", 0.07, 0.8],
  ["Facebook · Marketplace", 0.05, 0.7],
  ["Audience Network · Native, banner & interstitial", 0.06, 0.35],
  ["Messenger · Inbox", 0.03, 0.5],
];
const DEVICES: [string, number, number][] = [
  ["MOBILE", 0.68, 0.9],
  ["DESKTOP", 0.27, 1.35],
  ["TABLET", 0.05, 0.9],
];
const HOUR_CURVE = [
  0.012, 0.008, 0.006, 0.005, 0.006, 0.01, 0.02, 0.032, 0.042, 0.048, 0.05, 0.052, 0.054, 0.052, 0.05, 0.05, 0.052, 0.056, 0.062, 0.068,
  0.07, 0.066, 0.05, 0.029,
];
const WEEKLY = [1.0, 0.98, 0.97, 1.0, 1.03, 1.08, 1.1];

// ───────────────────────── demo clients ─────────────────────────
function ad(id: string, name: string, type: AdDef["type"], perf: number, w: number, landing: string, extra: Partial<AdDef> = {}): AdDef {
  return {
    id,
    name,
    type,
    perf,
    w,
    landing,
    headline: extra.headline ?? name,
    body: extra.body ?? "Clinically tested formulas your skin will love. Free shipping over $50.",
    hook: type === "VIDEO" ? (extra.hook ?? 0.28) : undefined,
    hold: type === "VIDEO" ? (extra.hold ?? 0.22) : undefined,
    ...extra,
  };
}

const AURORA: ClientDef = {
  name: "Aurora Skincare",
  slug: "aurora-skincare",
  currency: "USD",
  timezone: "America/New_York",
  margin: 72,
  seed: 1337,
  accounts: [
    {
      platform: "META",
      externalId: "act_1029384756",
      name: "Aurora – US Prospecting",
      currency: "USD",
      timezone: "America/New_York",
      dailySpend: 2600,
      cpm: 16,
      ctr: 0.0145,
      cvr: 0.024,
      atcRate: 0.11,
      aov: 74,
      trackFunnel: true,
      countries: [
        ["US", 0.82],
        ["CA", 0.09],
        ["GB", 0.05],
        ["AU", 0.04],
      ],
      campaigns: [
        {
          id: "120210001",
          name: "PROSP | ASC+ | Bestsellers",
          objective: "OUTCOME_SALES",
          type: "ADVANTAGE_PLUS_SHOPPING",
          prospecting: true,
          share: 0.42,
          roasMult: 1.1,
          adsets: [
            {
              id: "120211001",
              name: "ASC+ | Broad | US",
              w: 1,
              ads: [
                ad(
                  "120219001",
                  "VID | Glow in 7 days – UGC Sarah",
                  "VIDEO",
                  1.45,
                  1.4,
                  "https://auroraskin.co/products/vitamin-c-glow-serum",
                  {
                    hook: 0.36,
                    hold: 0.27,
                    headline: "Glow in 7 days, or it's free",
                    body: "Sarah tried our Vitamin C Serum for a week. Here's what happened ✨",
                  },
                ),
                ad(
                  "120219002",
                  "IMG | Serum flatlay – Before/After",
                  "IMAGE",
                  1.05,
                  1.0,
                  "https://auroraskin.co/products/vitamin-c-glow-serum",
                  { headline: "Brighter skin starts here" },
                ),
                ad("120219003", "CAR | Routine 3-step", "CAROUSEL", 0.9, 0.8, "https://auroraskin.co/collections/routines", {
                  headline: "Your 3-step morning routine",
                }),
              ],
            },
            {
              id: "120211002",
              name: "ASC+ | Existing cap 10%",
              w: 0.6,
              ads: [
                ad("120219004", "VID | Founder story 30s", "VIDEO", 0.8, 0.9, "https://auroraskin.co/", {
                  hook: 0.24,
                  hold: 0.31,
                  headline: "Why we started Aurora",
                }),
                ad("120219005", "IMG | Bundle 20% off", "IMAGE", 1.2, 0.8, "https://auroraskin.co/products/glow-ritual-bundle", {
                  headline: "The Glow Ritual Bundle — save 20%",
                }),
                ad("120219006", "VID | Dermatologist review", "VIDEO", 0.45, 0.7, "https://auroraskin.co/pages/derm-approved", {
                  hook: 0.19,
                  hold: 0.14,
                  headline: "A dermatologist reviews our serum",
                }),
              ],
            },
          ],
        },
        {
          id: "120210002",
          name: "PROSP | Interests | Skincare lovers",
          objective: "OUTCOME_SALES",
          type: "MANUAL",
          prospecting: true,
          share: 0.28,
          roasMult: 0.85,
          adsets: [
            {
              id: "120211003",
              name: "INT | Clean beauty 25-54 F",
              w: 1,
              ads: [
                ad("120219007", "VID | Texture ASMR", "VIDEO", 1.0, 1.0, "https://auroraskin.co/products/hydra-barrier-moisturizer", {
                  hook: 0.41,
                  hold: 0.18,
                  headline: "That texture though 😮‍💨",
                }),
                ad("120219008", "IMG | Press quotes", "IMAGE", 0.75, 0.9, "https://auroraskin.co/", {
                  headline: "As seen in Vogue & Allure",
                }),
                ad("120219009", "IMG | Retinol night", "IMAGE", 0.35, 0.8, "https://auroraskin.co/products/retinol-night-repair", {
                  headline: "Wake up to smoother skin",
                }),
              ],
            },
            {
              id: "120211004",
              name: "INT | Sephora / Ulta shoppers",
              w: 0.8,
              ads: [
                ad(
                  "120219010",
                  "VID | Glow in 7 days – UGC Sarah",
                  "VIDEO",
                  1.3,
                  1.0,
                  "https://auroraskin.co/products/vitamin-c-glow-serum",
                  { hook: 0.35, hold: 0.26, headline: "Glow in 7 days, or it's free" },
                ),
                ad("120219011", "CAR | Bestsellers", "CAROUSEL", 0.95, 0.9, "https://auroraskin.co/collections/bestsellers"),
                ad("120219012", "IMG | Quiz – find your routine", "IMAGE", 0.7, 0.7, "https://auroraskin.co/pages/skin-quiz", {
                  headline: "Take the 60-second skin quiz",
                }),
              ],
            },
          ],
        },
        {
          id: "120210003",
          name: "PROSP | LAL 1-3% Purchasers",
          objective: "OUTCOME_SALES",
          type: "MANUAL",
          prospecting: true,
          share: 0.2,
          roasMult: 0.95,
          adsets: [
            {
              id: "120211005",
              name: "LAL 1% Purchasers 180d",
              w: 1,
              ads: [
                ad("120219013", "VID | Morning routine GRWM", "VIDEO", 1.1, 1.0, "https://auroraskin.co/collections/routines", {
                  hook: 0.31,
                  hold: 0.24,
                }),
                ad("120219014", "IMG | SPF everyday", "IMAGE", 0.85, 0.8, "https://auroraskin.co/products/spf-50-daily-shield"),
                ad("120219015", "IMG | Reviews 4.8★", "IMAGE", 1.0, 0.8, "https://auroraskin.co/", {
                  headline: "12,000+ five-star reviews",
                }),
              ],
            },
            {
              id: "120211006",
              name: "LAL 3% Engagers",
              w: 0.6,
              ads: [
                ad("120219016", "IMG | Cleanser close-up", "IMAGE", 0.6, 1.0, "https://auroraskin.co/products/gentle-foam-cleanser"),
                ad(
                  "120219017",
                  "VID | Glow in 7 days – UGC Sarah",
                  "VIDEO",
                  1.25,
                  1.0,
                  "https://auroraskin.co/products/vitamin-c-glow-serum",
                  { hook: 0.34, hold: 0.25 },
                ),
                ad(
                  "120219018",
                  "IMG | Before & after – rejected claim",
                  "IMAGE",
                  0.9,
                  0.3,
                  "https://auroraskin.co/products/retinol-night-repair",
                  { status: "DISAPPROVED", review: "Ad rejected: Before-and-after images (Personal health policy)" },
                ),
              ],
            },
          ],
        },
        {
          id: "120210004",
          name: "TEST | Creative testing",
          objective: "OUTCOME_SALES",
          type: "MANUAL",
          prospecting: true,
          share: 0.1,
          roasMult: 0.8,
          adsets: [
            {
              id: "120211007",
              name: "CT | Hooks batch 14",
              w: 1,
              ads: [
                ad(
                  "120219019",
                  "VID | Hook – 'Stop scrolling if…'",
                  "VIDEO",
                  1.15,
                  1.0,
                  "https://auroraskin.co/products/vitamin-c-glow-serum",
                  { hook: 0.44, hold: 0.2 },
                ),
                ad(
                  "120219020",
                  "VID | Hook – 'My derm told me…'",
                  "VIDEO",
                  0.55,
                  1.0,
                  "https://auroraskin.co/products/vitamin-c-glow-serum",
                  { hook: 0.22, hold: 0.17 },
                ),
                ad("120219021", "VID | Hook – 'POV: glass skin'", "VIDEO", 0.95, 1.0, "https://auroraskin.co/products/hyaluronic-toner", {
                  hook: 0.38,
                  hold: 0.21,
                }),
              ],
            },
            {
              id: "120211008",
              name: "CT | Statics batch 9",
              w: 0.7,
              ads: [
                ad("120219022", "IMG | Ingredient callouts", "IMAGE", 0.4, 1.0, "https://auroraskin.co/products/vitamin-c-glow-serum"),
                ad("120219023", "IMG | Us vs them", "IMAGE", 1.05, 1.0, "https://auroraskin.co/"),
                ad("120219024", "IMG | Gift guide", "IMAGE", 0.7, 0.8, "https://auroraskin.co/collections/gifts"),
              ],
            },
          ],
        },
      ],
    },
    {
      platform: "META",
      externalId: "act_5647382910",
      name: "Aurora – Retargeting",
      currency: "USD",
      timezone: "America/New_York",
      dailySpend: 620,
      cpm: 24,
      ctr: 0.021,
      cvr: 0.042,
      atcRate: 0.16,
      aov: 71,
      trackFunnel: true,
      countries: [
        ["US", 0.86],
        ["CA", 0.08],
        ["GB", 0.06],
      ],
      disruptions: [{ offset: -61, spendMult: 0, convMult: 0 }],
      campaigns: [
        {
          id: "120220001",
          name: "RT | DPA | Viewed 14d",
          objective: "OUTCOME_SALES",
          type: "CATALOG",
          prospecting: false,
          share: 0.6,
          roasMult: 1.5,
          adsets: [
            {
              id: "120221001",
              name: "DPA | VC/ATC 14d",
              w: 1,
              ads: [
                ad("120229001", "DPA | Catalog carousel", "CAROUSEL", 1.2, 1, "https://auroraskin.co/collections/all"),
                ad("120229002", "DPA | Collection ad", "CAROUSEL", 0.9, 0.7, "https://auroraskin.co/collections/all"),
              ],
            },
            {
              id: "120221002",
              name: "DPA | IC 7d",
              w: 0.5,
              ads: [
                ad("120229003", "IMG | Free shipping reminder", "IMAGE", 1.3, 1, "https://auroraskin.co/cart", {
                  headline: "Your cart misses you 🛒",
                }),
                ad("120229004", "IMG | 10% code", "IMAGE", 1.0, 0.6, "https://auroraskin.co/cart"),
              ],
            },
          ],
        },
        {
          id: "120220002",
          name: "RT | Engagers 30d | Social proof",
          objective: "OUTCOME_SALES",
          type: "MANUAL",
          prospecting: false,
          share: 0.4,
          roasMult: 1.1,
          adsets: [
            {
              id: "120221003",
              name: "IG/FB engagers 30d",
              w: 1,
              ads: [
                ad("120229005", "VID | Reviews montage", "VIDEO", 1.1, 1, "https://auroraskin.co/", { hook: 0.3, hold: 0.3 }),
                ad("120229006", "IMG | 12k reviews", "IMAGE", 0.9, 0.8, "https://auroraskin.co/"),
              ],
            },
            {
              id: "120221004",
              name: "Site visitors 30d excl. buyers",
              w: 0.7,
              ads: [
                ad("120229007", "IMG | Bundle offer", "IMAGE", 1.15, 1, "https://auroraskin.co/products/glow-ritual-bundle"),
                ad("120229008", "VID | How to use", "VIDEO", 0.7, 0.8, "https://auroraskin.co/pages/how-to-use", {
                  hook: 0.25,
                  hold: 0.33,
                }),
              ],
            },
          ],
        },
      ],
    },
    {
      platform: "GOOGLE",
      externalId: "482-193-7710",
      name: "Aurora Skincare – Google Ads",
      currency: "USD",
      timezone: "America/New_York",
      dailySpend: 1250,
      cpm: 38,
      ctr: 0.034,
      cvr: 0.034,
      atcRate: 0.12,
      aov: 72,
      trackFunnel: true,
      countries: [
        ["US", 0.9],
        ["CA", 0.1],
      ],
      campaigns: [
        {
          id: "21000001",
          name: "Search | Brand",
          objective: "SALES",
          type: "SEARCH",
          prospecting: false,
          share: 0.14,
          roasMult: 2.6,
          searchTerms: [
            "aurora skincare",
            "aurora serum",
            "aurora skin care reviews",
            "aurora vitamin c",
            "aurora skincare discount code",
            "auroraskin",
          ],
          adsets: [
            {
              id: "31000001",
              name: "Brand – Exact",
              w: 1,
              keywords: ["[aurora skincare]", "[aurora serum]"],
              ads: [ad("41000001", "RSA | Brand – Official site", "TEXT", 1.2, 1, "https://auroraskin.co/")],
            },
            {
              id: "31000002",
              name: "Brand – Phrase",
              w: 0.5,
              keywords: ['"aurora skin care"', '"aurora vitamin c"'],
              ads: [ad("41000002", "RSA | Brand – Offer", "TEXT", 1.0, 1, "https://auroraskin.co/")],
            },
          ],
        },
        {
          id: "21000002",
          name: "Search | Non-brand | Serums",
          objective: "SALES",
          type: "SEARCH",
          prospecting: true,
          share: 0.24,
          roasMult: 0.75,
          searchTerms: [
            "best vitamin c serum",
            "vitamin c serum for dark spots",
            "serum for glowing skin",
            "retinol serum",
            "hyaluronic acid serum",
            "clean skincare brands",
          ],
          adsets: [
            {
              id: "31000003",
              name: "Vitamin C serum",
              w: 1,
              keywords: ["vitamin c serum", "best vitamin c serum", "+vitamin +c +serum +dark +spots"],
              ads: [ad("41000003", "RSA | Vitamin C – Benefits", "TEXT", 1.0, 1, "https://auroraskin.co/products/vitamin-c-glow-serum")],
            },
            {
              id: "31000004",
              name: "Retinol / anti-aging",
              w: 0.7,
              keywords: ["retinol serum", "anti aging night cream"],
              ads: [ad("41000004", "RSA | Retinol – Night repair", "TEXT", 0.8, 1, "https://auroraskin.co/products/retinol-night-repair")],
            },
          ],
        },
        {
          id: "21000003",
          name: "PMax | All products",
          objective: "SALES",
          type: "PERFORMANCE_MAX",
          prospecting: true,
          share: 0.34,
          roasMult: 1.05,
          adsets: [
            {
              id: "31000005",
              name: "Asset group – Bestsellers",
              w: 1,
              ads: [ad("41000005", "PMax | Bestsellers assets", "IMAGE", 1.05, 1, "https://auroraskin.co/collections/bestsellers")],
            },
            {
              id: "31000006",
              name: "Asset group – Bundles",
              w: 0.6,
              ads: [ad("41000006", "PMax | Bundle assets", "IMAGE", 1.1, 1, "https://auroraskin.co/products/glow-ritual-bundle")],
            },
          ],
        },
        {
          id: "21000004",
          name: "Shopping | Standard",
          objective: "SALES",
          type: "SHOPPING",
          prospecting: true,
          share: 0.18,
          roasMult: 0.95,
          adsets: [
            {
              id: "31000007",
              name: "All products",
              w: 1,
              ads: [ad("41000007", "Shopping | Product ads", "IMAGE", 1.0, 1, "https://auroraskin.co/collections/all")],
            },
          ],
        },
        {
          id: "21000005",
          name: "YouTube | Awareness",
          objective: "AWARENESS",
          type: "VIDEO",
          prospecting: true,
          share: 0.1,
          roasMult: 0.25,
          adsets: [
            {
              id: "31000008",
              name: "In-feed – Skincare intenders",
              w: 1,
              ads: [
                ad("41000008", "YT | Glow in 7 days 30s", "VIDEO", 1, 1, "https://auroraskin.co/products/vitamin-c-glow-serum", {
                  hook: 0.3,
                  hold: 0.24,
                }),
              ],
            },
          ],
        },
      ],
    },
  ],
  shop: {
    domain: "aurora-skincare.myshopify.com",
    name: "Aurora Skincare (Shopify)",
    organicOrders: 22,
    attributionDeflator: 0.56,
    newShare: 0.6,
    freeShippingOver: 50,
    shippingFee: 5.95,
    taxRate: 0.07,
    feePct: 0.029,
    feeFixed: 0.3,
    codes: [
      { code: "WELCOME10", pct: 0.1, p: 0.18, newOnly: true },
      { code: "GLOW15", pct: 0.15, p: 0.06 },
    ],
    promoCode: { code: "SUMMER25", pct: 0.25 },
    products: [
      { id: "8001", title: "Vitamin C Glow Serum", price: 58, cost: 9.5, pop: 3.2 },
      { id: "8002", title: "Hydra Barrier Moisturizer", price: 46, cost: 7.2, pop: 2.2 },
      { id: "8003", title: "Retinol Night Repair", price: 64, cost: 11, pop: 1.4 },
      { id: "8004", title: "Gentle Foam Cleanser", price: 28, cost: 4.1, pop: 1.8 },
      { id: "8005", title: "SPF 50 Daily Shield", price: 36, cost: 6.0, pop: 1.5 },
      { id: "8006", title: "Glow Ritual Bundle", price: 129, cost: 24, pop: 0.9 },
      { id: "8007", title: "Hyaluronic Toner", price: 32, cost: 5.2, pop: 1.1 },
      { id: "8008", title: "Eye Revive Cream", price: 42, cost: null, pop: 0.7 },
    ],
  },
  other: [{ source: "Wholesale", daily: 0, aov: 1450, dow: 0 }],
  promos: [
    { offset: -98, len: 4, spend: 1.55, conv: 1.45, title: "Summer Glow Sale (25% off)", category: "PROMOTION" },
    { offset: -26, len: 3, spend: 1.35, conv: 1.3, title: "Anniversary weekend", category: "PROMOTION" },
  ],
  notes: [
    {
      offset: -120,
      title: "Launched ASC+ campaign",
      description: "Moved 40% of prospecting budget into Advantage+ Shopping.",
      category: "BUDGET_CHANGE",
    },
    { offset: -98, title: "Summer Glow Sale starts", description: "25% sitewide with code SUMMER25, 4 days.", category: "PROMOTION" },
    { offset: -75, title: "New UGC batch live", description: "UGC Sarah + texture ASMR videos launched.", category: "NEW_CREATIVE" },
    {
      offset: -61,
      title: "Retargeting card declined",
      description: "Retargeting account stopped spending for a day.",
      category: "TRACKING_ISSUE",
    },
    { offset: -44, title: "New PDP layout", description: "Reviews moved above the fold on product pages.", category: "SITE_CHANGE" },
    { offset: -26, title: "Anniversary weekend", description: "Gift with purchase over $80.", category: "PROMOTION" },
    { offset: -9, title: "Raised Google PMax budget +20%", description: "", category: "BUDGET_CHANGE" },
  ],
};

const CASA_VERDE: ClientDef = {
  name: "Casa Verde Home",
  slug: "casa-verde",
  currency: "BRL",
  timezone: "America/Sao_Paulo",
  margin: 58,
  seed: 4242,
  accounts: [
    {
      platform: "META",
      externalId: "act_7766554433",
      name: "Casa Verde – Brasil",
      currency: "BRL",
      timezone: "America/Sao_Paulo",
      dailySpend: 6200,
      cpm: 28,
      ctr: 0.0165,
      cvr: 0.0115,
      atcRate: 0.085,
      aov: 335,
      trackFunnel: true,
      countries: [["BR", 1]],
      disruptions: [
        { offset: -21, spendMult: 1, convMult: 0.35 },
        { offset: -20, spendMult: 1, convMult: 0.3 },
        { offset: -19, spendMult: 1, convMult: 0.4 },
      ],
      campaigns: [
        {
          id: "238500001",
          name: "[CONV] ASC+ | Catálogo completo",
          objective: "OUTCOME_SALES",
          type: "ADVANTAGE_PLUS_SHOPPING",
          prospecting: true,
          share: 0.4,
          roasMult: 1.05,
          adsets: [
            {
              id: "238510001",
              name: "ASC+ | Brasil | Aberto",
              w: 1,
              ads: [
                ad("238590001", "VID | Tour pela sala – Reels", "VIDEO", 1.35, 1.2, "https://casaverde.com.br/collections/sala", {
                  hook: 0.33,
                  hold: 0.25,
                  headline: "Sua sala mais aconchegante",
                  body: "Peças artesanais brasileiras com frete grátis acima de R$299.",
                }),
                ad(
                  "238590002",
                  "IMG | Manta tricô – lifestyle",
                  "IMAGE",
                  1.0,
                  1.0,
                  "https://casaverde.com.br/products/manta-trico-algodao",
                  { headline: "Manta Tricô 100% algodão", body: "Feita à mão em Minas Gerais." },
                ),
                ad("238590003", "CAR | Mais vendidos", "CAROUSEL", 0.95, 0.9, "https://casaverde.com.br/collections/mais-vendidos", {
                  headline: "Os favoritos da casa",
                  body: "Os 6 produtos mais amados pelos clientes.",
                }),
              ],
            },
            {
              id: "238510002",
              name: "ASC+ | Clientes existentes 15%",
              w: 0.5,
              ads: [
                ad("238590004", "VID | Bastidores ateliê", "VIDEO", 0.7, 1.0, "https://casaverde.com.br/", {
                  hook: 0.21,
                  hold: 0.33,
                  headline: "Conheça quem faz suas peças",
                  body: "Por trás de cada peça, uma artesã.",
                }),
                ad("238590005", "IMG | Kit toalhas linho", "IMAGE", 1.1, 1.0, "https://casaverde.com.br/products/kit-toalhas-linho", {
                  headline: "Linho que dura anos",
                  body: "Kit com 4 peças.",
                }),
                ad("238590006", "IMG | Luminária palha", "IMAGE", 0.4, 0.8, "https://casaverde.com.br/products/luminaria-palha", {
                  headline: "Luz natural, feita à mão",
                  body: "Luminária de palha de carnaúba.",
                }),
              ],
            },
          ],
        },
        {
          id: "238500002",
          name: "[CONV] Interesses | Decoração",
          objective: "OUTCOME_SALES",
          type: "MANUAL",
          prospecting: true,
          share: 0.25,
          roasMult: 0.8,
          adsets: [
            {
              id: "238510003",
              name: "INT | Decoração + Design de interiores",
              w: 1,
              ads: [
                ad("238590007", "VID | Antes e depois – quarto", "VIDEO", 1.1, 1.0, "https://casaverde.com.br/collections/quarto", {
                  hook: 0.37,
                  hold: 0.22,
                  headline: "Transforme seu quarto",
                  body: "Antes e depois com peças Casa Verde.",
                }),
                ad("238590008", "IMG | Vaso cerâmica", "IMAGE", 0.8, 1.0, "https://casaverde.com.br/products/vaso-ceramica-terra", {
                  headline: "Cerâmica Terra",
                  body: "Moldado à mão.",
                }),
                ad("238590009", "IMG | Promo frete grátis", "IMAGE", 0.9, 0.8, "https://casaverde.com.br/", {
                  headline: "Frete grátis acima de R$299",
                  body: "Para todo o Brasil.",
                }),
              ],
            },
            {
              id: "238510004",
              name: "INT | Casa & jardim 30-55",
              w: 0.7,
              ads: [
                ad("238590010", "CAR | Mesa posta", "CAROUSEL", 1.0, 1.0, "https://casaverde.com.br/collections/mesa-posta", {
                  headline: "Mesa posta completa",
                  body: "Jogos americanos, guardanapos e mais.",
                }),
                ad("238590011", "VID | Difusor – ASMR", "VIDEO", 0.6, 0.9, "https://casaverde.com.br/products/difusor-aromas-brasil", {
                  hook: 0.4,
                  hold: 0.15,
                  headline: "Aromas do Brasil",
                  body: "Difusor de varetas 250ml.",
                }),
                ad("238590012", "IMG | Almofadas bordadas", "IMAGE", 0.85, 0.8, "https://casaverde.com.br/products/almofada-bordada", {
                  headline: "Almofadas bordadas à mão",
                  body: "Novas cores.",
                }),
              ],
            },
          ],
        },
        {
          id: "238500003",
          name: "[RMKT] DPA | Visitantes 30d",
          objective: "OUTCOME_SALES",
          type: "CATALOG",
          prospecting: false,
          share: 0.23,
          roasMult: 1.6,
          adsets: [
            {
              id: "238510005",
              name: "DPA | VC/ATC 30d",
              w: 1,
              ads: [
                ad("238590013", "DPA | Carrossel catálogo", "CAROUSEL", 1.2, 1, "https://casaverde.com.br/collections/all", {
                  headline: "Ainda pensando nisso?",
                  body: "Seus itens favoritos esperam por você.",
                }),
                ad("238590014", "IMG | Cupom CASA15", "IMAGE", 1.1, 0.7, "https://casaverde.com.br/cart", {
                  headline: "15% OFF hoje",
                  body: "Use o cupom CASA15.",
                }),
              ],
            },
            {
              id: "238510006",
              name: "Engajamento IG 60d",
              w: 0.6,
              ads: [
                ad("238590015", "VID | Depoimentos clientes", "VIDEO", 1.0, 1, "https://casaverde.com.br/", {
                  hook: 0.27,
                  hold: 0.29,
                  headline: "Quem compra, ama",
                  body: "+8.000 avaliações 5 estrelas.",
                }),
                ad("238590016", "IMG | Avaliações", "IMAGE", 0.9, 0.8, "https://casaverde.com.br/", {
                  headline: "4,9 de 5 estrelas",
                  body: "Veja o que dizem.",
                }),
              ],
            },
          ],
        },
        {
          id: "238500004",
          name: "[LEADS] Catálogo B2B arquitetos",
          objective: "OUTCOME_LEADS",
          type: "MANUAL",
          prospecting: true,
          share: 0.12,
          roasMult: 0,
          leadGen: true,
          adsets: [
            {
              id: "238510007",
              name: "Arquitetos + Designers",
              w: 1,
              ads: [
                ad("238590017", "LEAD | Catálogo PDF arquitetos", "IMAGE", 1.1, 1, "https://casaverde.com.br/pages/b2b", {
                  headline: "Catálogo exclusivo para arquitetos",
                  body: "Condições especiais para projetos.",
                }),
                ad("238590018", "LEAD | Vídeo showroom", "VIDEO", 0.8, 1, "https://casaverde.com.br/pages/b2b", {
                  hook: 0.26,
                  hold: 0.2,
                  headline: "Visite nosso showroom",
                  body: "Agende uma visita.",
                }),
              ],
            },
          ],
        },
      ],
    },
    {
      platform: "META",
      externalId: "act_3344221100",
      name: "Casa Verde – LATAM (USD)",
      currency: "USD",
      timezone: "America/Sao_Paulo",
      dailySpend: 290,
      cpm: 6.5,
      ctr: 0.015,
      cvr: 0.007,
      atcRate: 0.07,
      aov: 64,
      trackFunnel: true,
      countries: [
        ["MX", 0.34],
        ["AR", 0.22],
        ["CL", 0.18],
        ["CO", 0.16],
        ["PE", 0.1],
      ],
      campaigns: [
        {
          id: "238600001",
          name: "[CONV] LATAM | Broad",
          objective: "OUTCOME_SALES",
          type: "MANUAL",
          prospecting: true,
          share: 0.7,
          roasMult: 0.8,
          adsets: [
            {
              id: "238610001",
              name: "LATAM | Broad 25-55",
              w: 1,
              ads: [
                ad("238690001", "VID | Tour sala – ES", "VIDEO", 1.0, 1, "https://casaverde.com.br/es/collections/sala", {
                  hook: 0.3,
                  hold: 0.22,
                  headline: "Tu sala más acogedora",
                  body: "Envíos a toda Latinoamérica.",
                }),
                ad("238690002", "IMG | Manta – ES", "IMAGE", 0.8, 1, "https://casaverde.com.br/es/products/manta-trico-algodao", {
                  headline: "Manta tejida a mano",
                  body: "100% algodón brasileño.",
                }),
              ],
            },
            {
              id: "238610002",
              name: "LATAM | Deco interests",
              w: 0.7,
              ads: [
                ad("238690003", "CAR | Bestsellers – ES", "CAROUSEL", 0.9, 1, "https://casaverde.com.br/es/collections/mais-vendidos", {
                  headline: "Los favoritos",
                  body: "Lo más vendido.",
                }),
                ad("238690004", "IMG | Envío gratis", "IMAGE", 0.7, 1, "https://casaverde.com.br/es/", {
                  headline: "Envío gratis",
                  body: "En compras mayores a US$80.",
                }),
              ],
            },
          ],
        },
        {
          id: "238600002",
          name: "[RMKT] LATAM | DPA",
          objective: "OUTCOME_SALES",
          type: "CATALOG",
          prospecting: false,
          share: 0.3,
          roasMult: 1.4,
          adsets: [
            {
              id: "238610003",
              name: "DPA 30d",
              w: 1,
              ads: [
                ad("238690005", "DPA | Catálogo ES", "CAROUSEL", 1.1, 1, "https://casaverde.com.br/es/collections/all", {
                  headline: "¿Lo sigues pensando?",
                  body: "Tus favoritos te esperan.",
                }),
                ad("238690006", "IMG | Cupón 10%", "IMAGE", 1.0, 1, "https://casaverde.com.br/es/cart", {
                  headline: "10% OFF",
                  body: "Cupón LATAM10.",
                }),
              ],
            },
          ],
        },
      ],
    },
    {
      platform: "GOOGLE",
      externalId: "771-302-5519",
      name: "Casa Verde – Google Ads",
      currency: "BRL",
      timezone: "America/Sao_Paulo",
      dailySpend: 2600,
      cpm: 55,
      ctr: 0.028,
      cvr: 0.016,
      atcRate: 0.1,
      aov: 342,
      trackFunnel: false,
      countries: [["BR", 1]],
      campaigns: [
        {
          id: "22000001",
          name: "Pesquisa | Marca",
          objective: "SALES",
          type: "SEARCH",
          prospecting: false,
          share: 0.12,
          roasMult: 2.8,
          searchTerms: ["casa verde", "casa verde decoração", "casa verde home", "casa verde loja", "casa verde cupom"],
          adsets: [
            {
              id: "32000001",
              name: "Marca – Exata",
              w: 1,
              keywords: ["[casa verde]", "[casa verde home]"],
              ads: [ad("42000001", "RSA | Marca – Site oficial", "TEXT", 1.1, 1, "https://casaverde.com.br/")],
            },
          ],
        },
        {
          id: "22000002",
          name: "Pesquisa | Genérico | Decoração",
          objective: "SALES",
          type: "SEARCH",
          prospecting: true,
          share: 0.26,
          roasMult: 0.75,
          searchTerms: [
            "manta de tricô",
            "vaso de cerâmica grande",
            "luminária de palha",
            "toalha de linho",
            "jogo americano juta",
            "decoração sala pequena",
          ],
          adsets: [
            {
              id: "32000002",
              name: "Têxteis",
              w: 1,
              keywords: ["manta tricô", "toalha linho", "almofada bordada"],
              ads: [ad("42000002", "RSA | Têxteis artesanais", "TEXT", 1.0, 1, "https://casaverde.com.br/collections/texteis")],
            },
            {
              id: "32000003",
              name: "Decoração",
              w: 0.8,
              keywords: ["vaso cerâmica", "luminária palha", "+decoração +sala"],
              ads: [ad("42000003", "RSA | Decoração artesanal", "TEXT", 0.85, 1, "https://casaverde.com.br/collections/decoracao")],
            },
          ],
        },
        {
          id: "22000003",
          name: "PMax | Catálogo",
          objective: "SALES",
          type: "PERFORMANCE_MAX",
          prospecting: true,
          share: 0.44,
          roasMult: 1.0,
          adsets: [
            {
              id: "32000004",
              name: "Grupo – Mais vendidos",
              w: 1,
              ads: [ad("42000004", "PMax | Mais vendidos", "IMAGE", 1.05, 1, "https://casaverde.com.br/collections/mais-vendidos")],
            },
            {
              id: "32000005",
              name: "Grupo – Mesa posta",
              w: 0.6,
              ads: [ad("42000005", "PMax | Mesa posta", "IMAGE", 0.9, 1, "https://casaverde.com.br/collections/mesa-posta")],
            },
          ],
        },
        {
          id: "22000004",
          name: "Demand Gen | Inspiração",
          objective: "CONSIDERATION",
          type: "DEMAND_GEN",
          prospecting: true,
          share: 0.18,
          roasMult: 0.45,
          adsets: [
            {
              id: "32000006",
              name: "Interesse – Decoração",
              w: 1,
              ads: [
                ad("42000006", "DG | Tour sala vídeo", "VIDEO", 1, 1, "https://casaverde.com.br/collections/sala", {
                  hook: 0.27,
                  hold: 0.2,
                }),
              ],
            },
          ],
        },
      ],
    },
  ],
  shop: {
    domain: "casaverde-home.myshopify.com",
    name: "Casa Verde (Shopify)",
    organicOrders: 18,
    attributionDeflator: 0.7,
    newShare: 0.7,
    freeShippingOver: 299,
    shippingFee: 24.9,
    taxRate: 0,
    feePct: 0.0399,
    feeFixed: 0,
    codes: [
      { code: "BEMVINDO10", pct: 0.1, p: 0.2, newOnly: true },
      { code: "CASA15", pct: 0.15, p: 0.07 },
    ],
    promoCode: { code: "SEMANA20", pct: 0.2 },
    products: [
      { id: "9001", title: "Manta Tricô Algodão", price: 249, cost: 98, pop: 2.4 },
      { id: "9002", title: "Vaso Cerâmica Terra", price: 189, cost: 62, pop: 1.9 },
      { id: "9003", title: "Kit Toalhas Linho", price: 329, cost: 140, pop: 1.3 },
      { id: "9004", title: "Luminária Palha", price: 279, cost: 110, pop: 1.0 },
      { id: "9005", title: "Jogo Americano Juta (4un)", price: 139, cost: 45, pop: 1.6 },
      { id: "9006", title: "Almofada Bordada", price: 119, cost: 38, pop: 1.7 },
      { id: "9007", title: "Difusor Aromas Brasil", price: 99, cost: 28, pop: 1.5 },
      { id: "9008", title: "Cesto Organizador Fibra", price: 159, cost: 55, pop: 1.1 },
    ],
  },
  other: [
    { source: "Mercado Livre", daily: 3800, aov: 205 },
    { source: "Amazon", daily: 1250, aov: 182 },
  ],
  promos: [
    { offset: -105, len: 6, spend: 1.4, conv: 1.35, title: "Dia dos Pais", category: "PROMOTION" },
    { offset: -63, len: 5, spend: 1.5, conv: 1.5, title: "Semana do Cliente (20% off)", category: "PROMOTION" },
  ],
  notes: [
    { offset: -105, title: "Campanha Dia dos Pais", description: "Kit presentes + frete grátis.", category: "PROMOTION" },
    { offset: -88, title: "Lançamento coleção Mesa Posta", description: "6 novos SKUs.", category: "OFFER_LAUNCH" },
    { offset: -63, title: "Semana do Cliente", description: "20% em todo o site com SEMANA20.", category: "PROMOTION" },
    { offset: -50, title: "Conta LATAM ativada", description: "Teste de expansão para MX, AR, CL, CO, PE.", category: "BUDGET_CHANGE" },
    {
      offset: -21,
      title: "Pixel Meta quebrado no checkout",
      description: "Tema atualizado removeu o evento Purchase por 3 dias.",
      category: "TRACKING_ISSUE",
    },
    { offset: -12, title: "Novos criativos de Reels", description: "Tour pela sala + ASMR difusor.", category: "NEW_CREATIVE" },
  ],
};

export const DEMO_CLIENTS = [AURORA, CASA_VERDE];

// ───────────────────────── generation ─────────────────────────

type Metrics = {
  spend: number;
  impressions: number;
  reach: number | null;
  clicks: number;
  linkClicks: number | null;
  purchases: number;
  purchaseValue: number;
  addToCart: number | null;
  initiateCheckout: number | null;
  leads: number | null;
  results: number | null;
  resultsValue: number | null;
  videoViews3s: number | null;
  thruPlays: number | null;
  allConversions: number | null;
  viewThroughConv: number | null;
  searchImprShare: number | null;
};

const zero = (): Metrics => ({
  spend: 0,
  impressions: 0,
  reach: 0,
  clicks: 0,
  linkClicks: 0,
  purchases: 0,
  purchaseValue: 0,
  addToCart: 0,
  initiateCheckout: 0,
  leads: 0,
  results: 0,
  resultsValue: 0,
  videoViews3s: 0,
  thruPlays: 0,
  allConversions: 0,
  viewThroughConv: 0,
  searchImprShare: null,
});

function addInto(a: Metrics, b: Metrics) {
  for (const k of Object.keys(a) as (keyof Metrics)[]) {
    if (k === "searchImprShare") continue;
    const bv = b[k];
    const av = a[k];
    if (bv === null) continue;
    (a[k] as number | null) = (av ?? 0) + bv;
  }
}

function finalize(m: Metrics, plat: Plat, trackFunnel: boolean, hasVideo: boolean): Metrics {
  return {
    ...m,
    spend: round2(m.spend),
    purchaseValue: round2(m.purchaseValue),
    resultsValue: m.resultsValue === null ? null : round2(m.resultsValue),
    reach: plat === "META" ? m.reach : null,
    linkClicks: plat === "META" ? m.linkClicks : null,
    addToCart: trackFunnel ? m.addToCart : null,
    initiateCheckout: trackFunnel ? m.initiateCheckout : null,
    videoViews3s: hasVideo ? m.videoViews3s : null,
    thruPlays: hasVideo ? m.thruPlays : null,
    allConversions: plat === "GOOGLE" ? m.allConversions : null,
    viewThroughConv: plat === "GOOGLE" ? m.viewThroughConv : null,
  };
}

interface Ctx {
  db: DB;
  clientId: string;
  rng: Rng;
  days: string[];
  today: string;
  todayFrac: number;
  fx: Map<string, number>; // date → USD→BRL
}

type InsightRow = Record<string, unknown>;

async function insertBatches<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

function promoFactor(def: ClientDef, dayIdx: number, today: string, day: string) {
  const offset = Math.round((Date.parse(day) - Date.parse(today)) / DAY);
  for (const p of def.promos) if (offset >= p.offset && offset < p.offset + p.len) return { spend: p.spend, conv: p.conv, code: true };
  return { spend: 1, conv: 1, code: false };
}

function dayOffset(today: string, day: string) {
  return Math.round((Date.parse(day) - Date.parse(today)) / DAY);
}

/** Generates ad insights for one account; returns per-day purchases (for driving Shopify). */
async function generateAccount(ctx: Ctx, def: ClientDef, acc: AccountDef, connectionId: string) {
  const { rng, days, today } = ctx;
  const daily: InsightRow[] = [];
  const breakdowns: InsightRow[] = [];
  const purchasesByDay = new Map<string, number>();
  const spendByDay = new Map<string, number>(); // in account currency
  const accHasVideo = acc.campaigns.some((c) => c.adsets.some((s) => s.ads.some((a) => a.type === "VIDEO")));
  const isMeta = acc.platform === "META";

  // dimension rows
  const entities: InsightRow[] = [];
  const creatives: InsightRow[] = [];
  for (const c of acc.campaigns) {
    entities.push({
      connectionId,
      clientId: ctx.clientId,
      platform: acc.platform,
      level: "CAMPAIGN",
      externalId: c.id,
      name: c.name,
      status: "ACTIVE",
      effectiveStatus: "ACTIVE",
      objective: c.objective,
      campaignType: c.type,
      isProspecting: c.prospecting,
      dailyBudget: round2(acc.dailySpend * c.share),
    });
    for (const s of c.adsets) {
      entities.push({
        connectionId,
        clientId: ctx.clientId,
        platform: acc.platform,
        level: "ADSET",
        externalId: s.id,
        name: s.name,
        campaignExternalId: c.id,
        status: "ACTIVE",
        effectiveStatus: "ACTIVE",
        isProspecting: c.prospecting,
      });
      for (const a of s.ads) {
        entities.push({
          connectionId,
          clientId: ctx.clientId,
          platform: acc.platform,
          level: "AD",
          externalId: a.id,
          name: a.name,
          campaignExternalId: c.id,
          adsetExternalId: s.id,
          status: a.status ?? "ACTIVE",
          effectiveStatus: a.status ?? "ACTIVE",
          reviewFeedback: a.review ?? null,
          landingUrl: a.landing,
          creativeId: `cr_${a.id}`,
          isProspecting: c.prospecting,
        });
        if (a.type !== "TEXT") {
          creatives.push({
            connectionId,
            clientId: ctx.clientId,
            platform: acc.platform,
            adExternalId: a.id,
            externalId: `cr_${a.id}`,
            name: a.name,
            type: a.type,
            thumbnailUrl: `/api/demo/thumb/${a.id}`,
            headline: a.headline,
            body: a.body,
            landingUrl: a.landing,
          });
        }
      }
      for (const kw of s.keywords ?? []) {
        entities.push({
          connectionId,
          clientId: ctx.clientId,
          platform: acc.platform,
          level: "KEYWORD",
          externalId: `${s.id}~${kw}`,
          name: kw,
          campaignExternalId: c.id,
          adsetExternalId: s.id,
          status: "ENABLED",
          effectiveStatus: "ENABLED",
        });
      }
    }
  }
  await ctx.db.adEntity.createMany({ data: entities as never });
  if (creatives.length) await ctx.db.creative.createMany({ data: creatives as never });

  const baseRow = (day: string) => ({
    clientId: ctx.clientId,
    connectionId,
    platform: acc.platform,
    date: asDate(day),
    currency: acc.currency,
  });

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const off = dayOffset(today, day);
    const isToday = day === today;
    const trend = 0.82 + 0.3 * (i / days.length);
    const promo = promoFactor(def, i, today, day);
    // LATAM account started 50 days ago
    if (acc.externalId === "act_3344221100" && off < -50) continue;
    const disruption = acc.disruptions?.find((d) => d.offset === off);
    let daySpend = acc.dailySpend * trend * WEEKLY[dowOf(day)] * promo.spend * rng.noise(0.1);
    if (disruption) daySpend *= disruption.spendMult;
    if (isToday) daySpend *= ctx.todayFrac;
    const convDisrupt = disruption?.convMult ?? 1;

    const accountM = zero();
    let accountSisWeighted = 0;

    for (const c of acc.campaigns) {
      const campM = zero();
      let campSisW = 0;
      const campSpend = daySpend * c.share * rng.noise(0.12);
      const setW = c.adsets.map((s) => s.w * rng.noise(0.15));
      const setWSum = setW.reduce((a, b) => a + b, 0);

      for (let si = 0; si < c.adsets.length; si++) {
        const s = c.adsets[si];
        const setM = zero();
        const setSpend = campSpend * (setW[si] / setWSum);
        const adW = s.ads.map((a) => a.w * (a.status === "DISAPPROVED" ? (off > -30 ? 0 : 1) : 1) * rng.noise(0.2));
        const adWSum = adW.reduce((a, b) => a + b, 0) || 1;

        for (let ai = 0; ai < s.ads.length; ai++) {
          const a = s.ads[ai];
          const spend = setSpend * (adW[ai] / adWSum);
          if (spend <= 0.009) continue;
          const cpm = acc.cpm * rng.noise(0.15) * (c.prospecting ? 1 : 1.35);
          const impressions = Math.max(1, Math.round((spend / cpm) * 1000));
          const ctr = acc.ctr * (a.ctr ?? 1) * rng.noise(0.18) * (c.prospecting ? 1 : 1.3);
          const clicks = rng.round(impressions * ctr);
          const perf = a.perf * promo.conv * convDisrupt;
          let purchases = 0,
            value = 0,
            leads = 0;
          if (c.leadGen) {
            leads = rng.round(clicks * 0.075 * a.perf * rng.noise(0.25));
          } else {
            purchases = rng.round(clicks * acc.cvr * perf * c.roasMult * rng.noise(0.3));
            value = purchases * acc.aov * rng.noise(0.18);
          }
          const atc = c.leadGen
            ? 0
            : Math.max(purchases, rng.round(clicks * acc.atcRate * Math.sqrt(a.perf * promo.conv) * rng.noise(0.2)));
          const ic = c.leadGen ? 0 : Math.max(purchases, Math.round(purchases + (atc - purchases) * 0.32 * rng.noise(0.2)));
          const isVideo = a.type === "VIDEO";
          const v3 = isVideo ? rng.round(impressions * (a.hook ?? 0.25) * rng.noise(0.12)) : 0;
          const thru = isVideo ? rng.round(v3 * (a.hold ?? 0.2) * rng.noise(0.12)) : 0;
          const sis = !isMeta && c.type === "SEARCH" ? Math.min(0.97, (c.prospecting ? 0.42 : 0.9) * rng.noise(0.1)) : null;

          const m: Metrics = {
            spend,
            impressions,
            reach: Math.round(impressions / rng.range(1.15, 1.9)),
            clicks,
            linkClicks: Math.round(clicks * rng.range(0.62, 0.8)),
            purchases,
            purchaseValue: value,
            addToCart: atc,
            initiateCheckout: ic,
            leads,
            results: c.leadGen ? leads : purchases,
            resultsValue: c.leadGen ? 0 : value,
            videoViews3s: v3,
            thruPlays: thru,
            allConversions: Math.round(purchases * rng.range(1.15, 1.5)),
            viewThroughConv:
              c.type === "VIDEO" || c.type === "DEMAND_GEN" || c.type === "PERFORMANCE_MAX" ? rng.round(purchases * 0.15) : 0,
            searchImprShare: sis,
          };
          if (sis !== null) campSisW += sis * impressions;
          addInto(setM, m);

          daily.push({
            ...baseRow(day),
            level: "AD",
            entityId: a.id,
            entityName: a.name,
            campaignId: c.id,
            campaignName: c.name,
            adsetId: s.id,
            adsetName: s.name,
            adId: a.id,
            ...finalize(m, acc.platform, acc.trackFunnel, isVideo),
          });

          // Google keywords: split the ad group's search traffic across keywords
          if (!isMeta && s.keywords?.length && ai === 0) {
            const kwW = s.keywords.map((_, ki) => (ki === 0 ? 1.6 : 1) * rng.noise(0.3));
            const sumW = kwW.reduce((x, y) => x + y, 0);
            const purchSplit = apportion(
              purchases,
              kwW.map((w, ki) => w * (ki === 0 ? 1.2 : 0.9)),
            );
            const clickSplit = apportion(clicks, kwW);
            const imprSplit = apportion(impressions, kwW);
            s.keywords.forEach((kw, ki) => {
              const share = kwW[ki] / sumW;
              const kp = purchSplit[ki];
              daily.push({
                ...baseRow(day),
                level: "KEYWORD",
                entityId: `${s.id}~${kw}`,
                entityName: kw,
                campaignId: c.id,
                campaignName: c.name,
                adsetId: s.id,
                adsetName: s.name,
                spend: round2(spend * share),
                impressions: imprSplit[ki],
                clicks: clickSplit[ki],
                purchases: kp,
                purchaseValue: round2(purchases ? (value * kp) / purchases : 0),
                addToCart: acc.trackFunnel ? Math.round(atc * share) : null,
                initiateCheckout: acc.trackFunnel ? Math.round(ic * share) : null,
                searchImprShare: sis,
                results: kp,
                resultsValue: round2(purchases ? (value * kp) / purchases : 0),
              });
            });
          }
        }
        addInto(campM, setM);
        daily.push({
          ...baseRow(day),
          level: "ADSET",
          entityId: s.id,
          entityName: s.name,
          campaignId: c.id,
          campaignName: c.name,
          adsetId: s.id,
          adsetName: s.name,
          ...finalize(setM, acc.platform, acc.trackFunnel, accHasVideo),
        });
      }

      if (campM.impressions > 0 && campSisW > 0) campM.searchImprShare = campSisW / campM.impressions;
      accountSisWeighted += campSisW;
      addInto(accountM, campM);
      const campFinal = finalize(campM, acc.platform, acc.trackFunnel, accHasVideo);
      daily.push({
        ...baseRow(day),
        level: "CAMPAIGN",
        entityId: c.id,
        entityName: c.name,
        campaignId: c.id,
        campaignName: c.name,
        ...campFinal,
      });

      // Search terms (Google search campaigns)
      if (!isMeta && c.searchTerms?.length) {
        const w = c.searchTerms.map((_, k) => (1 / (k + 1.2)) * rng.noise(0.3));
        const sumW = w.reduce((x, y) => x + y, 0);
        const pS = apportion(campM.purchases, w);
        const cS = apportion(campM.clicks, w);
        const iS = apportion(campM.impressions, w);
        c.searchTerms.forEach((term, k) => {
          daily.push({
            ...baseRow(day),
            level: "SEARCH_TERM",
            entityId: `${c.id}~${term}`,
            entityName: term,
            campaignId: c.id,
            campaignName: c.name,
            spend: round2((campM.spend * w[k]) / sumW),
            impressions: iS[k],
            clicks: cS[k],
            purchases: pS[k],
            purchaseValue: round2(campM.purchases ? (campM.purchaseValue * pS[k]) / campM.purchases : 0),
            results: pS[k],
          });
        });
      }

      // ── Breakdowns (campaign level, full days only for HOUR) ──
      if (campM.spend > 0) {
        const dims: [string, [string, number, number][]][] = isMeta
          ? [
              ["AGE", AGES],
              ["GENDER", GENDERS_META],
              ["PLACEMENT", PLACEMENTS],
              ["COUNTRY", acc.countries.map(([cc, w]) => [cc, w, 1] as [string, number, number])],
              [
                "AUDIENCE_TYPE",
                c.prospecting
                  ? [
                      ["New audience", def.slug === "casa-verde" ? 0.52 : 0.72, 1.05],
                      ["Engaged audience", def.slug === "casa-verde" ? 0.3 : 0.19, 1.1],
                      ["Existing customers", def.slug === "casa-verde" ? 0.18 : 0.09, 0.8],
                    ]
                  : [
                      ["New audience", 0.08, 0.6],
                      ["Engaged audience", 0.62, 1.1],
                      ["Existing customers", 0.3, 0.9],
                    ],
              ],
              [
                "HOUR",
                HOUR_CURVE.map(
                  (w, h) => [String(h).padStart(2, "0"), w, h >= 19 && h <= 22 ? 1.2 : h < 6 ? 0.6 : 1] as [string, number, number],
                ),
              ],
            ]
          : [
              ["AGE", [...AGES, ["Undetermined", 0.08, 0.9]]],
              ["GENDER", GENDERS_GOOGLE],
              ["DEVICE", DEVICES],
              ["COUNTRY", acc.countries.map(([cc, w]) => [cc, w, 1] as [string, number, number])],
              [
                "HOUR",
                HOUR_CURVE.map((w, h) => [String(h).padStart(2, "0"), w, h >= 8 && h <= 22 ? 1.1 : 0.7] as [string, number, number]),
              ],
            ];
        for (const [type, segs] of dims) {
          if (type === "HOUR" && isToday) continue;
          const sw = segs.map(([, w]) => w * rng.noise(0.12));
          const swSum = sw.reduce((x, y) => x + y, 0);
          const pw = segs.map(([, , p], k) => sw[k] * p);
          const imprSplit = apportion(
            campM.impressions,
            sw.map((w, k) => w * (segs[k][2] > 1 ? 0.92 : 1.05)),
          );
          const clickSplit = apportion(
            campM.clicks,
            sw.map((w, k) => w * Math.sqrt(segs[k][2])),
          );
          const purchSplit = apportion(campM.purchases, pw);
          const leadSplit = apportion(campM.leads ?? 0, pw);
          const atcSplit = apportion(
            campM.addToCart ?? 0,
            pw.map((w) => Math.sqrt(w)),
          );
          const icSplit = apportion(campM.initiateCheckout ?? 0, pw);
          const reachSplit = apportion(campM.reach ?? 0, sw);
          let spendLeft = round2(campM.spend);
          segs.forEach(([val], k) => {
            const segSpend = k === segs.length - 1 ? round2(spendLeft) : round2((campM.spend * sw[k]) / swSum);
            spendLeft = round2(spendLeft - segSpend);
            const pv = campM.purchases ? (campM.purchaseValue * purchSplit[k]) / campM.purchases : 0;
            breakdowns.push({
              ...baseRow(day),
              level: "CAMPAIGN",
              entityId: c.id,
              entityName: c.name,
              campaignId: c.id,
              breakdownType: type,
              breakdownValue: val,
              spend: Math.max(0, segSpend),
              impressions: imprSplit[k],
              reach: isMeta ? reachSplit[k] : null,
              clicks: clickSplit[k],
              linkClicks: isMeta ? Math.round(clickSplit[k] * 0.72) : null,
              purchases: purchSplit[k],
              purchaseValue: round2(pv),
              addToCart: acc.trackFunnel ? atcSplit[k] : null,
              initiateCheckout: acc.trackFunnel ? icSplit[k] : null,
              leads: c.leadGen ? leadSplit[k] : 0,
              results: c.leadGen ? leadSplit[k] : purchSplit[k],
              resultsValue: c.leadGen ? 0 : round2(pv),
            });
          });
        }
      }
    }

    if (accountM.impressions > 0 && accountSisWeighted > 0) accountM.searchImprShare = accountSisWeighted / accountM.impressions;
    const accFinal = finalize(accountM, acc.platform, acc.trackFunnel, accHasVideo);
    daily.push({ ...baseRow(day), level: "ACCOUNT", entityId: acc.externalId, entityName: acc.name, ...accFinal });
    // Alternative attribution windows (Meta, account level)
    if (isMeta) {
      for (const [attr, f] of [
        ["7d_click", 0.84],
        ["1d_click", 0.62],
      ] as const) {
        const p = Math.round(accFinal.purchases * f);
        daily.push({
          ...baseRow(day),
          level: "ACCOUNT",
          entityId: acc.externalId,
          entityName: acc.name,
          attribution: attr,
          spend: accFinal.spend,
          impressions: accFinal.impressions,
          clicks: accFinal.clicks,
          purchases: p,
          purchaseValue: round2(accFinal.purchaseValue * (accFinal.purchases ? p / accFinal.purchases : 0)),
        });
      }
    }
    // Shopify is driven by *true* demand (before the pixel outage reduced reported conversions)
    purchasesByDay.set(day, (purchasesByDay.get(day) ?? 0) + accountM.purchases / convDisrupt);
    spendByDay.set(day, accountM.spend);
  }

  await insertBatches(daily, 4000, (chunk) => ctx.db.adInsightDaily.createMany({ data: chunk as never }));
  await insertBatches(breakdowns, 5000, (chunk) => ctx.db.adInsightBreakdown.createMany({ data: chunk as never }));
  return { purchasesByDay, spendByDay, rows: daily.length + breakdowns.length };
}

async function generateShopify(
  ctx: Ctx,
  def: ClientDef,
  connectionId: string,
  demand: Map<string, number>,
  channelSpend: Map<string, { META: number; GOOGLE: number }>,
) {
  const { rng, days, today } = ctx;
  const shop = def.shop;
  const orders: InsightRow[] = [];
  const lines: InsightRow[] = [];
  const refunds: InsightRow[] = [];
  const pool: string[] = Array.from({ length: 9000 }, (_, i) => `cust_pre_${def.slug}_${i}`);
  let custSeq = 0;
  let orderSeq = 1001;
  const tzOffsetH = def.timezone === "America/Sao_Paulo" ? 3 : 5;
  const productWeights = shop.products.map((p) => [p, p.pop] as const);

  for (const day of days) {
    const off = dayOffset(today, day);
    const isToday = day === today;
    const promo = promoFactor(def, 0, today, day);
    const platformPurch = demand.get(day) ?? 0;
    let expected =
      shop.organicOrders * WEEKLY[dowOf(day)] * promo.conv * (isToday ? ctx.todayFrac : 1) + platformPurch * shop.attributionDeflator;
    expected *= rng.noise(0.08);
    const n = rng.round(expected);
    const sp = channelSpend.get(day) ?? { META: 1, GOOGLE: 1 };
    const metaW = sp.META / Math.max(1, sp.META + sp.GOOGLE);

    for (let k = 0; k < n; k++) {
      const isNew = rng.chance(shop.newShare);
      const customer = isNew ? `cust_${def.slug}_${custSeq++}` : rng.pick(pool);
      if (isNew) pool.push(customer);
      const nLines = rng.weighted([
        [1, 0.6],
        [2, 0.3],
        [3, 0.1],
      ] as const);
      let gross = 0,
        cogs = 0;
      const orderId = randomUUID();
      const usedProducts = new Set<string>();
      for (let l = 0; l < nLines; l++) {
        const p = rng.weighted(productWeights);
        if (usedProducts.has(p.id)) continue;
        usedProducts.add(p.id);
        const qty = rng.chance(0.15) ? 2 : 1;
        gross += p.price * qty;
        cogs += (p.cost ?? p.price * (1 - def.margin / 100)) * qty;
        lines.push({
          id: randomUUID(),
          orderId,
          productId: p.id,
          variantId: `${p.id}01`,
          sku: `SKU-${p.id}`,
          title: p.title,
          variantTitle: "Default",
          quantity: qty,
          price: p.price,
          discount: 0,
          unitCost: p.cost,
        });
      }
      // discount
      let code: { code: string; pct: number } | null = null;
      if (promo.code && rng.chance(0.62)) code = shop.promoCode;
      else
        for (const c of shop.codes)
          if ((!c.newOnly || isNew) && rng.chance(c.p)) {
            code = c;
            break;
          }
      const discount = code ? round2(gross * code.pct) : 0;
      const sub = gross - discount;
      const shipping = sub >= shop.freeShippingOver ? 0 : shop.shippingFee;
      const taxes = round2(sub * shop.taxRate);
      const total = round2(sub + shipping + taxes);

      // attribution (UTMs)
      const last = rng.weighted([
        ["META", 0.5 * metaW + 0.12],
        ["GOOGLE", 0.5 * (1 - metaW) + 0.08],
        ["EMAIL", 0.11],
        ["ORGANIC", 0.08],
        ["DIRECT", 0.1],
        ["OTHER", 0.025],
      ] as const);
      const first = rng.chance(0.72)
        ? last
        : rng.weighted([
            ["META", 0.45],
            ["GOOGLE", 0.3],
            ["ORGANIC", 0.15],
            ["OTHER", 0.1],
          ] as const);
      const utm = (ch: string) =>
        ch === "META"
          ? ["facebook", rng.chance(0.5) ? "paid_social" : "cpc"]
          : ch === "GOOGLE"
            ? ["google", "cpc"]
            : ch === "EMAIL"
              ? ["klaviyo", "email"]
              : ch === "OTHER"
                ? ["tiktok", "paid_social"]
                : [null, null];
      const [ls, lm] = utm(last);
      const [fs, fm] = utm(first);
      const hour = rng.weighted(HOUR_CURVE.map((w, h) => [h, w] as const));
      const processedAt = new Date(Date.parse(day + "T00:00:00Z") + (hour + tzOffsetH) * 3600_000 + rng.int(0, 3599) * 1000);

      const landing = ls
        ? `/products/${rng
            .pick(shop.products)
            .title.toLowerCase()
            .normalize("NFD")
            .replace(/[^a-z0-9]+/g, "-")}?utm_source=${ls}&utm_medium=${lm}`
        : rng.pick(["/", "/collections/all", "/pages/about"]);
      orders.push({
        id: orderId,
        clientId: ctx.clientId,
        connectionId,
        externalId: `gid://shopify/Order/${def.seed}${orderSeq}`,
        name: `#${orderSeq++}`,
        processedAt,
        date: asDate(day),
        currency: def.currency,
        customerExternalId: customer,
        isNewCustomer: isNew,
        financialStatus: "PAID",
        grossSales: round2(gross),
        discounts: discount,
        shipping,
        taxes,
        totalPrice: total,
        cogs: round2(cogs),
        paymentFees: round2(total * shop.feePct + shop.feeFixed),
        discountCodes: code ? [code.code] : [],
        sourceName: "web",
        landingSite: landing,
        referringSite: last === "ORGANIC" ? "https://www.google.com/" : last === "META" ? "https://l.instagram.com/" : null,
        firstUtmSource: fs,
        firstUtmMedium: fm,
        lastUtmSource: ls,
        lastUtmMedium: lm,
        lastUtmCampaign: ls ? "auto" : null,
        channelFirstClick: first,
        channelLastClick: last,
      });

      // refunds, booked on the refund date
      if (rng.chance(0.045)) {
        const rDay = addDays(day, rng.int(2, 14));
        if (rDay <= addDays(today, -1)) {
          const amount = round2(rng.chance(0.55) ? sub : sub * rng.range(0.3, 0.6));
          refunds.push({
            orderId,
            clientId: ctx.clientId,
            externalId: `r_${orderId.slice(0, 8)}`,
            date: asDate(rDay),
            amount,
            currency: def.currency,
          });
          orders[orders.length - 1].refunded = amount;
          orders[orders.length - 1].financialStatus = amount >= sub ? "REFUNDED" : "PARTIALLY_REFUNDED";
        }
      }
    }
    void off;
  }

  await insertBatches(orders, 3000, (chunk) => ctx.db.shopifyOrder.createMany({ data: chunk as never }));
  await insertBatches(lines, 5000, (chunk) => ctx.db.shopifyOrderLine.createMany({ data: chunk as never }));
  await insertBatches(refunds, 3000, (chunk) => ctx.db.shopifyRefund.createMany({ data: chunk as never }));
  return { orders: orders.length };
}

export async function wipeDemo(db: DB) {
  const demo = await db.client.findMany({ where: { isDemo: true }, select: { id: true } });
  const ids = demo.map((c) => c.id);
  if (!ids.length) return;
  const w = { clientId: { in: ids } };
  await db.adInsightBreakdown.deleteMany({ where: w });
  await db.adInsightDaily.deleteMany({ where: w });
  await db.adEntity.deleteMany({ where: w });
  await db.creative.deleteMany({ where: w });
  await db.shopifyRefund.deleteMany({ where: w });
  await db.shopifyOrder.deleteMany({ where: w }); // lines cascade
  await db.client.deleteMany({ where: { id: { in: ids } } }); // connections, targets, notes… cascade
}

export async function seedFx(db: DB, days: string[], rng: Rng) {
  let rate = 5.38;
  const rows = days.map((d) => {
    rate = Math.min(5.9, Math.max(4.9, rate * (1 + (rng.next() - 0.5) * 0.012)));
    return { date: asDate(d), base: "USD", quote: "BRL", rate: Math.round(rate * 10000) / 10000 };
  });
  await db.fxRate.deleteMany({ where: { base: "USD", quote: "BRL", date: { gte: asDate(days[0]), lte: asDate(days[days.length - 1]) } } });
  await db.fxRate.createMany({ data: rows });
  return new Map(rows.map((r) => [iso(r.date), r.rate]));
}

export async function seedDemo(db: DB, organizationId: string, opts: { days?: number } = {}) {
  const nDays = opts.days ?? 180;
  await wipeDemo(db);
  const fxToday = todayIn("America/New_York");
  const fxDays = Array.from({ length: nDays + 1 }, (_, i) => addDays(fxToday, i - nDays));
  const fx = await seedFx(db, fxDays, new Rng(99));
  const summary: string[] = [];

  for (const def of DEMO_CLIENTS) {
    const rng = new Rng(def.seed);
    const today = todayIn(def.timezone);
    const days = Array.from({ length: nDays + 1 }, (_, i) => addDays(today, i - nDays));
    const client = await db.client.create({
      data: {
        organizationId,
        name: def.name,
        slug: def.slug,
        currency: def.currency,
        timezone: def.timezone,
        defaultMarginPct: def.margin,
        paymentFeePct: def.shop.feePct * 100,
        shippingCostPerOrder: def.currency === "BRL" ? 22 : 6.5,
        newAudienceMinPct: 60,
        isDemo: true,
      },
    });
    const ctx: Ctx = { db, clientId: client.id, rng, days, today, todayFrac: hourFractionIn(def.timezone), fx };
    const demand = new Map<string, number>();
    const channelSpend = new Map<string, { META: number; GOOGLE: number }>();
    let rows = 0;

    for (const acc of def.accounts) {
      const conn = await db.connection.create({
        data: {
          clientId: client.id,
          platform: acc.platform,
          externalId: acc.externalId,
          name: acc.name,
          currency: acc.currency,
          timezone: acc.timezone,
          status: "OK",
          isDemo: true,
          lastSyncAt: new Date(),
          lastSuccessAt: new Date(),
          meta: acc.platform === "META" ? { attributionSetting: "7d_click_1d_view" } : { loginCustomerId: "100-200-3000" },
          backfillFrom: asDate(days[0]),
          backfillProgress: 1,
        },
      });
      const r = await generateAccount(ctx, def, acc, conn.id);
      rows += r.rows;
      for (const [d, p] of r.purchasesByDay) demand.set(d, (demand.get(d) ?? 0) + p);
      for (const [d, s] of r.spendByDay) {
        const cur = channelSpend.get(d) ?? { META: 0, GOOGLE: 0 };
        const inRc = acc.currency === def.currency ? s : s * (fx.get(d) ?? 5.4);
        cur[acc.platform] += inRc;
        channelSpend.set(d, cur);
      }
    }

    const shopConn = await db.connection.create({
      data: {
        clientId: client.id,
        platform: "SHOPIFY",
        externalId: def.shop.domain,
        name: def.shop.name,
        currency: def.currency,
        timezone: def.timezone,
        status: "OK",
        isDemo: true,
        lastSyncAt: new Date(),
        lastSuccessAt: new Date(),
        backfillFrom: asDate(days[0]),
        backfillProgress: 1,
      },
    });
    const shopRes = await generateShopify(ctx, def, shopConn.id, demand, channelSpend);

    // Other revenue
    const otherRows: InsightRow[] = [];
    if (def.other.length) {
      const orConn = await db.connection.create({
        data: {
          clientId: client.id,
          platform: "OTHER_REVENUE",
          externalId: "manual",
          name: "Other revenue (manual / CSV / webhook)",
          currency: def.currency,
          timezone: def.timezone,
          status: "OK",
          isDemo: true,
          lastSuccessAt: new Date(),
        },
      });
      for (const day of days) {
        if (day === today) continue;
        for (const src of def.other) {
          let revenue: number;
          if (src.dow !== undefined) {
            if (dowOf(day) !== src.dow) continue;
            revenue = src.aov * rng.int(2, 5);
          } else revenue = src.daily * WEEKLY[dowOf(day)] * rng.noise(0.2);
          otherRows.push({
            clientId: client.id,
            connectionId: orConn.id,
            date: asDate(day),
            source: src.source,
            revenue: Math.round(revenue / 100) * 100,
            orders: Math.max(1, Math.round(revenue / src.aov)),
            currency: def.currency,
          });
        }
      }
      await db.otherRevenue.createMany({ data: otherRows as never });
    }

    // Chart notes
    await db.chartNote.createMany({
      data: def.notes.map((n) => ({
        clientId: client.id,
        date: asDate(addDays(today, n.offset)),
        title: n.title,
        description: n.description || null,
        category: n.category as never,
      })),
    });

    summary.push(
      `${def.name}: ${rows.toLocaleString()} ad rows, ${shopRes.orders.toLocaleString()} orders, ${otherRows.length} other-revenue rows`,
    );
  }

  await db.$executeRawUnsafe("SELECT refresh_reporting_views()");
  await seedTargets(db);
  summary.push(`${await seedSyncHistory(db)} demo sync jobs`);
  return summary;
}

/** Monthly targets set close to actuals (some months beat, some miss) so the colours are meaningful. */
async function seedTargets(db: DB) {
  const rng = new Rng(7);
  const clients = await db.client.findMany({ where: { isDemo: true } });
  for (const c of clients) {
    const months = await db.$queryRawUnsafe<
      { month: Date; spend: number; revenue: number; orders: number; new_customers: number; days: number }[]
    >(
      `SELECT date_trunc('month', date)::date AS month, SUM(ad_spend)::float AS spend, SUM(total_revenue)::float AS revenue,
              SUM(shopify_orders)::float AS orders, SUM(new_customers)::float AS new_customers, COUNT(*)::int AS days
       FROM v_client_daily WHERE client_id = $1 GROUP BY 1 ORDER BY 1`,
      c.id,
    );
    const plat = await db.$queryRawUnsafe<
      { month: Date; platform: string; spend: number; value: number; purchases: number; days: number }[]
    >(
      `SELECT date_trunc('month', date)::date AS month, platform, SUM(spend)::float AS spend, SUM(purchase_value)::float AS value, SUM(purchases)::float AS purchases, COUNT(DISTINCT date)::int AS days
       FROM mv_ad_daily WHERE client_id = $1 GROUP BY 1, 2`,
      c.id,
    );
    const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
    const rows: Record<string, unknown>[] = [];
    let last: (typeof months)[number] | null = null;
    const monthList = [...months.map((m) => m.month), nextMonth];
    for (const month of monthList) {
      const m: (typeof months)[number] | null = months.find((x) => +x.month === +month) ?? last;
      if (!m) continue;
      last = m;
      const dim = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
      const scale = dim / Math.max(1, m.days);
      const f = rng.range(0.94, 1.1);
      const spend = m.spend * scale * rng.range(0.95, 1.05);
      const revenue = m.revenue * scale * f;
      rows.push({
        clientId: c.id,
        month,
        platform: null,
        connectionId: null,
        spend: Math.round(spend / 100) * 100,
        revenue: Math.round(revenue / 100) * 100,
        mer: Math.round((revenue / spend) * 100) / 100,
        orders: Math.round(m.orders * scale * f),
        newCustomers: Math.round(m.new_customers * scale * f),
        ncac: Math.round((spend / Math.max(1, m.new_customers * scale)) * rng.range(0.92, 1.05)),
      });
      for (const p of plat.filter((x) => +x.month === +m.month)) {
        const roas = (p.value / p.spend) * rng.range(0.95, 1.1);
        rows.push({
          clientId: c.id,
          month,
          platform: p.platform,
          connectionId: null,
          spend: Math.round((p.spend * (dim / Math.max(1, p.days))) / 100) * 100,
          roas: Math.round(roas * 100) / 100,
          cpa: Math.round((p.spend / Math.max(1, p.purchases)) * rng.range(0.9, 1.04) * 2) / 2,
        });
      }
    }
    // prisma's @@unique with nullable columns: insert directly
    for (const r of rows) await db.target.create({ data: r as never });
  }
}

/** Plausible sync history for demo connections (so Sync Status / Overview have something to show). */
export async function seedSyncHistory(db: DB) {
  const rng = new Rng(2024);
  const conns = await db.connection.findMany({ where: { isDemo: true } });
  await db.syncJob.deleteMany({ where: { connectionId: { in: conns.map((c) => c.id) } } });
  const now = Date.now();
  const jobs: Record<string, unknown>[] = [];
  for (const c of conns) {
    const baseRows = c.platform === "SHOPIFY" ? 120 : c.platform === "OTHER_REVENUE" ? 2 : 900;
    // initial backfill 14 days ago
    const bStart = new Date(now - 14 * DAY - rng.int(1, 5) * 3_600_000);
    jobs.push({
      connectionId: c.id,
      kind: "BACKFILL",
      status: "SUCCESS",
      startedAt: bStart,
      finishedAt: new Date(+bStart + rng.int(9, 40) * 60_000),
      createdAt: bStart,
      rowsWritten: baseRows * 300,
      rateLimitPct: rng.range(30, 70),
      progress: 1,
    });
    for (let h = 14 * 24; h >= 1; h--) {
      if (c.platform === "OTHER_REVENUE" && h % 24 !== 0) continue;
      const created = new Date(now - h * 3_600_000 + rng.int(0, 600) * 1000);
      const daily = h % 24 === 0;
      const failed = rng.chance(c.name.includes("LATAM") ? 0.06 : 0.015);
      const dur = (daily ? rng.int(60, 240) : rng.int(8, 50)) * 1000;
      jobs.push({
        connectionId: c.id,
        kind: daily ? "RESYNC_RANGE" : "INCREMENTAL",
        status: failed ? "FAILED" : "SUCCESS",
        createdAt: created,
        startedAt: created,
        finishedAt: new Date(+created + dur),
        rowsWritten: failed ? 0 : Math.round(baseRows * (daily ? 7 : 0.2) * rng.noise(0.3)),
        rateLimitPct:
          c.platform === "META" || c.platform === "GOOGLE" ? Math.round(rng.range(5, c.name.includes("Prospecting") ? 82 : 45)) : null,
        error: failed
          ? rng.pick([
              "(#80004) There have been too many calls to this ad-account. Wait a bit and try again.",
              "Network error calling API: socket hang up",
            ])
          : null,
        progress: failed ? null : 1,
      });
    }
  }
  for (let i = 0; i < jobs.length; i += 2000) await db.syncJob.createMany({ data: jobs.slice(i, i + 2000) as never });
  await db.connection.updateMany({
    where: { isDemo: true },
    data: {
      lastSuccessAt: new Date(now - 40 * 60_000),
      lastSyncAt: new Date(now - 40 * 60_000),
      nextSyncAt: new Date(Math.ceil(now / 3_600_000) * 3_600_000),
    },
  });
  return jobs.length;
}
