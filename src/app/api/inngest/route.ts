import { serve } from "inngest/next";
import { functions, inngest } from "@/server/queue/inngest";

/** Inngest calls this endpoint to run the sync functions (retries, schedules, concurrency are handled by Inngest). */
export const { GET, POST, PUT } = serve({ client: inngest, functions });

/** Syncs started from here run after the response (or as Inngest steps): allow the platform maximum. */
export const maxDuration = 300;
