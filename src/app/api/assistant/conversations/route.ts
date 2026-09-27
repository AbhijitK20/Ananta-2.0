/**
 * /api/assistant/conversations — CRUD for the sidebar.
 *
 * Every handler resolves the owner from the cookie and every store call takes
 * that owner. There is no route parameter that can widen the scope: an id
 * belonging to someone else returns 404, which is deliberately the same response
 * as a non-existent id, because "this exists but is not yours" is an enumeration
 * oracle.
 *
 * Methods: GET (list, `?search=` `?limit=`), POST (create), PATCH (rename),
 * DELETE. Messages are read through `?messages=1` on GET so the composer can load
 * a transcript without a second route.
 */
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
} from "@/features/assistant/store";
import { resolveOwner } from "@/features/assistant/owner";
import { MAX_TITLE_CHARS, sanitiseInput } from "@/features/assistant/orchestration/safety";
import { ConversationIdParam } from "@/features/assistant/orchestration/safety";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function withCookie(response: Response, setCookie: string | null): Response {
  if (!setCookie) return response;
  response.headers.append("Set-Cookie", setCookie);
  return response;
}

function owner(request: Request) {
  return resolveOwner(request.headers.get("cookie"), new URL(request.url).protocol === "https:");
}

export async function GET(request: Request): Promise<Response> {
  const { ownerId, setCookie } = owner(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (id) {
    const parsedId = ConversationIdParam.safeParse(id);
    if (!parsedId.success) return withCookie(Response.json({ error: "Bad id." }, { status: 400 }), setCookie);
    const conversation = await getConversation(ownerId, parsedId.data);
    if (!conversation) {
      return withCookie(Response.json({ error: "Not found." }, { status: 404 }), setCookie);
    }
    const messages = url.searchParams.get("messages") === "1" ? await listMessages(ownerId, conversation.id) : undefined;
    return withCookie(Response.json({ conversation, messages }), setCookie);
  }

  const search = url.searchParams.get("search") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
  const conversations = await listConversations(ownerId, {
    search,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return withCookie(Response.json({ conversations }), setCookie);
}

export async function POST(request: Request): Promise<Response> {
  const { ownerId, setCookie } = owner(request);
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty POST is a legitimate "new chat", so a body-less request is fine.
  }
  const title =
    typeof body === "object" && body !== null && "title" in body && typeof body.title === "string"
      ? sanitiseInput(body.title).slice(0, MAX_TITLE_CHARS)
      : "";
  const conversation = await createConversation(ownerId, { title });
  return withCookie(Response.json({ conversation }, { status: 201 }), setCookie);
}

export async function PATCH(request: Request): Promise<Response> {
  const { ownerId, setCookie } = owner(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCookie(Response.json({ error: "Request body was not valid JSON." }, { status: 400 }), setCookie);
  }
  const id = typeof body === "object" && body !== null && "id" in body ? String(body.id) : "";
  const title = typeof body === "object" && body !== null && "title" in body ? String(body.title) : "";
  const parsedId = ConversationIdParam.safeParse(id);
  if (!parsedId.success) return withCookie(Response.json({ error: "Bad id." }, { status: 400 }), setCookie);

  const conversation = await renameConversation(ownerId, parsedId.data, title);
  if (!conversation) return withCookie(Response.json({ error: "Not found." }, { status: 404 }), setCookie);
  return withCookie(Response.json({ conversation }), setCookie);
}

export async function DELETE(request: Request): Promise<Response> {
  const { ownerId, setCookie } = owner(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const parsedId = ConversationIdParam.safeParse(id);
  if (!parsedId.success) return withCookie(Response.json({ error: "Bad id." }, { status: 400 }), setCookie);

  const deleted = await deleteConversation(ownerId, parsedId.data);
  if (!deleted) return withCookie(Response.json({ error: "Not found." }, { status: 404 }), setCookie);
  return withCookie(Response.json({ ok: true }), setCookie);
}
