/** Chart Note categories. Colours follow the fixed categorical order (one hue per category, never cycled). */
export const NOTE_CATEGORIES = [
  { value: "OFFER_LAUNCH", label: "Offer launch", color: "var(--series-1)" },
  { value: "NEW_CREATIVE", label: "New creative", color: "var(--series-2)" },
  { value: "BUDGET_CHANGE", label: "Budget change", color: "var(--series-3)" },
  { value: "PROMOTION", label: "Promotion", color: "var(--series-4)" },
  { value: "TRACKING_ISSUE", label: "Tracking issue", color: "var(--series-8)" },
  { value: "SITE_CHANGE", label: "Site change", color: "var(--series-7)" },
  { value: "SEASONALITY", label: "Seasonality", color: "var(--series-6)" },
  { value: "OTHER", label: "Other", color: "var(--series-5)" },
] as const;

export type NoteCategory = (typeof NOTE_CATEGORIES)[number]["value"];

export const NOTE_CATEGORY_MAP = Object.fromEntries(NOTE_CATEGORIES.map((c) => [c.value, c])) as Record<
  NoteCategory,
  (typeof NOTE_CATEGORIES)[number]
>;

export interface ChartNoteDTO {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  description: string | null;
  category: NoteCategory;
}
