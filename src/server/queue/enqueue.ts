import "server-only";
import { after } from "next/server";
import { createJob, runSync, type SyncRequest } from "../sync/engine";
import { inngest, SYNC_EVENT } from "./inngest";

/** Inngest is used when configured (prod: INNGEST_EVENT_KEY; local: INNGEST_DEV=1 with `npx inngest-cli dev`). */
export function queueMode(): "inngest" | "inline" {
  return process.env.INNGEST_EVENT_KEY || process.env.INNGEST_DEV === "1" ? "inngest" : "inline";
}

/**
 * Queue a sync. Creates the job row immediately (status QUEUED) so the UI reflects it.
 * Without Inngest, the job runs in-process after the response is sent (good for local dev; no retries).
 */
export async function enqueueSync(req: Omit<SyncRequest, "jobId"> & { platform: string }) {
  const jobId = await createJob(req);
  if (queueMode() === "inngest") {
    await inngest.send({ name: SYNC_EVENT, data: { ...req, jobId } });
  } else {
    after(async () => {
      try {
        await runSync({ ...req, jobId });
      } catch (e) {
        console.error(`[sync] job ${jobId} crashed:`, (e as Error).message);
      }
    });
  }
  return jobId;
}
