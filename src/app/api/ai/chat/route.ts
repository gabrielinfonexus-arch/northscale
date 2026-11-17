import { z } from "zod";
import { getCurrentUser } from "@/server/auth";
import { canSeePage } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { runChat, scopedClients, type ChatEvent } from "@/server/ai/chat";
import { aiConfigured } from "@/server/ai/config";

const Body = z.object({
  conversationId: z.string().optional(),
  message: z.string().trim().min(1).max(8000),
  scope: z
    .object({ clientIds: z.array(z.string()).max(200).optional(), connectionIds: z.array(z.string()).max(500).optional() })
    .optional(),
  heavy: z.boolean().optional(),
});

/** Hive-Mind turn: streams Server-Sent Events while the model reads data with read-only tools. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  if (!aiConfigured()) return Response.json({ error: "Set ANTHROPIC_API_KEY to use Hive-Mind." }, { status: 503 });
  const user = await getCurrentUser();
  if (user.kind !== "user" || !canSeePage(user, "hive-mind")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const b = parsed.data;

  let conversationId = b.conversationId;
  if (conversationId) {
    const c = await prisma.aiConversation.findUnique({ where: { id: conversationId }, select: { userId: true } });
    if (!c || c.userId !== user.id) return Response.json({ error: "Conversation not found" }, { status: 404 });
  } else {
    // the scope can only narrow what the user may already see
    const scope = b.scope ?? {};
    const allowed = await scopedClients(user, {});
    const clientIds = (scope.clientIds ?? []).filter((id) => allowed.some((c) => c.id === id));
    const connIds = (scope.connectionIds ?? []).filter((id) => allowed.some((c) => c.connections.some((x) => x.id === id)));
    const created = await prisma.aiConversation.create({
      data: { userId: user.id, title: "New conversation", scope: { clientIds, connectionIds: connIds }, heavy: !!b.heavy },
    });
    conversationId = created.id;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const emit = (e: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false; // browser went away: keep going so the turn is saved
        }
      };
      emit({ type: "conversation", id: conversationId!, title: "" });
      try {
        await runChat({ user, conversationId: conversationId!, text: b.message, emit, signal: req.signal });
      } finally {
        if (open) controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}
