import { serve } from "inngest/next";
import { functions, inngest } from "@/server/queue/inngest";

/** Inngest calls this endpoint to run the sync functions (retries, schedules, concurrency are handled by Inngest). */
export const { GET, POST, PUT } = serve({ client: inngest, functions });
