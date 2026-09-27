/**
 * Conversation and message persistence.
 *
 * ## The ownership rule
 *
 * **Every function that reads or writes a message takes `ownerId` and filters on
 * it, through a subquery on the parent conversation.** There is no exported
 * function that can reach a message without proving ownership first, so
 * cross-user access is not something the tests check for — it is something the
 * module makes unrepresentable. A future edit that added
 * `getMessage(conversationId, messageId)` without the owner filter would be a
 * visible signature change rather than a silent hole.
 *
 * That is why messages are not fetched by `conversation_id` alone even though it
 * is indexed: an indexed read that skips the owner check is a fast data leak.
 *
 * ## Writes
 *
 * A conversation's `updated_at` is bumped on every message write so the sidebar's
 * `ORDER BY updated_at DESC` needs no join. A message is inserted as `streaming`
 * *before* the first token and rewritten in a `finally`, so an aborted request
 * leaves an honestly-labelled `stopped` or `error` row rather than a truncated
 * answer that reads as finished.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "./db";
import { assistantConversation, assistantMessage } from "@/db/schema";
import type { Message, MessageRole, MessageStatus, TokenUsage, Conversation } from "./types";
import { MAX_TITLE_CHARS, sanitiseInput } from "./orchestration/safety";
import { newId } from "@/lib/id";

type ConversationRow = typeof assistantConversation.$inferSelect;
type MessageRow = typeof assistantMessage.$inferSelect;

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata ?? {},
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt,
    modelId: row.modelId,
    tokenUsage: (row.tokenUsage as TokenUsage | null) ?? null,
    latencyMs: row.latencyMs,
    metadata: row.metadata ?? {},
  };
}

/**
 * A conversation title from its first message.
 *
 * Re-exported from `titles.ts` so callers have one import for "everything about
 * a stored conversation", while the function itself stays in a module that does
 * not open a database.
 */
export { titleFromMessage } from "./titles";

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function createConversation(
  ownerId: string,
  options: { title?: string; metadata?: Record<string, unknown> } = {},
): Promise<Conversation> {
  const now = new Date().toISOString();
  const row: ConversationRow = {
    id: newId("acv"),
    ownerId,
    title: options.title ?? "",
    createdAt: now,
    updatedAt: now,
    metadata: options.metadata ?? {},
  };
  await db().db.insert(assistantConversation).values(row);
  return toConversation(row);
}

export async function listConversations(
  ownerId: string,
  options: { search?: string; limit?: number; offset?: number } = {},
): Promise<Conversation[]> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  const search = options.search?.trim();

  // `search` is a LIKE against a column the owner already fully owns, so it
  // cannot widen visibility. The `%` and `_` are escaped so a search for "50%"
  // is a literal search rather than a wildcard.
  const pattern = search ? `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db().db
    .select()
    .from(assistantConversation)
    .where(
      and(
        eq(assistantConversation.ownerId, ownerId),
        pattern ? sql`${assistantConversation.title} LIKE ${pattern} ESCAPE '\\'` : undefined,
      ),
    )
    .orderBy(desc(assistantConversation.updatedAt))
    .limit(limit)
    .offset(offset);
  return rows.map(toConversation);
}

/** Null for "not yours" and for "does not exist" alike — deliberately indistinguishable. */
export async function getConversation(ownerId: string, id: string): Promise<Conversation | null> {
  const rows = await db().db
    .select()
    .from(assistantConversation)
    .where(and(eq(assistantConversation.id, id), eq(assistantConversation.ownerId, ownerId)))
    .limit(1);
  const row = rows[0];
  return row ? toConversation(row) : null;
}

export async function renameConversation(
  ownerId: string,
  id: string,
  title: string,
): Promise<Conversation | null> {
  const clean = sanitiseInput(title).slice(0, MAX_TITLE_CHARS);
  if (clean.length === 0) return null;
  const now = new Date().toISOString();
  // The owner predicate is in the WHERE, not checked after the fact, so a
  // cross-owner rename updates zero rows instead of renaming someone else's chat.
  const rows = await db().db
    .update(assistantConversation)
    .set({ title: clean, updatedAt: now })
    .where(and(eq(assistantConversation.id, id), eq(assistantConversation.ownerId, ownerId)))
    .returning();
  const row = rows[0];
  return row ? toConversation(row) : null;
}

/** True when a row was actually deleted, which is the caller's authorisation signal. */
export async function deleteConversation(ownerId: string, id: string): Promise<boolean> {
  const rows = await db().db
    .delete(assistantConversation)
    .where(and(eq(assistantConversation.id, id), eq(assistantConversation.ownerId, ownerId)))
    .returning({ id: assistantConversation.id });
  // Messages cascade (migration 5 declares ON DELETE CASCADE) and foreign keys
  // are switched on in createDatabase, so there is nothing left behind.
  return rows.length > 0;
}

async function touchConversation(id: string, at: string): Promise<void> {
  await db().db
    .update(assistantConversation)
    .set({ updatedAt: at })
    .where(eq(assistantConversation.id, id));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Owner-scoped existence check. The gate every message read and write goes through. */
async function ownsConversation(ownerId: string, conversationId: string): Promise<boolean> {
  const rows = await db().db
    .select({ id: assistantConversation.id })
    .from(assistantConversation)
    .where(
      and(
        eq(assistantConversation.id, conversationId),
        eq(assistantConversation.ownerId, ownerId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function listMessages(
  ownerId: string,
  conversationId: string,
  options: { limit?: number } = {},
): Promise<Message[]> {
  if (!(await ownsConversation(ownerId, conversationId))) return [];
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const rows = await db().db
    .select()
    .from(assistantMessage)
    .where(eq(assistantMessage.conversationId, conversationId))
    .orderBy(assistantMessage.createdAt)
    .limit(limit);
  return rows.map(toMessage);
}

export async function appendMessage(
  ownerId: string,
  conversationId: string,
  input: {
    role: MessageRole;
    content: string;
    status?: MessageStatus;
    modelId?: string | null;
    tokenUsage?: TokenUsage | null;
    latencyMs?: number | null;
    metadata?: Record<string, unknown>;
  },
): Promise<Message | null> {
  if (!(await ownsConversation(ownerId, conversationId))) return null;
  const now = new Date().toISOString();
  const row: MessageRow = {
    id: newId("ams"),
    conversationId,
    role: input.role,
    content: input.content,
    status: input.status ?? "complete",
    createdAt: now,
    modelId: input.modelId ?? null,
    tokenUsage: input.tokenUsage ?? null,
    latencyMs: input.latencyMs ?? null,
    metadata: input.metadata ?? {},
  };
  await db().db.insert(assistantMessage).values(row);
  await touchConversation(conversationId, now);
  return toMessage(row);
}

/**
 * Owner-scoped update of a message's content and status.
 *
 * The conversation id in the WHERE clause as well as the message id is what makes
 * this safe against a guessed message id: a message belonging to someone else's
 * conversation matches no row, because the subquery below requires the owner.
 */
export async function updateMessage(
  ownerId: string,
  messageId: string,
  patch: {
    content?: string;
    status?: MessageStatus;
    modelId?: string | null;
    tokenUsage?: TokenUsage | null;
    latencyMs?: number | null;
    metadata?: Record<string, unknown>;
  },
): Promise<Message | null> {
  const now = new Date().toISOString();
  const set: Partial<typeof assistantMessage.$inferInsert> = {};
  if (patch.content !== undefined) set.content = patch.content;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.modelId !== undefined) set.modelId = patch.modelId;
  if (patch.tokenUsage !== undefined) set.tokenUsage = patch.tokenUsage;
  if (patch.latencyMs !== undefined) set.latencyMs = patch.latencyMs;
  if (patch.metadata !== undefined) set.metadata = patch.metadata;
  if (Object.keys(set).length === 0) return null;

  const rows = await db().db
    .update(assistantMessage)
    .set(set)
    .where(
      and(
        eq(assistantMessage.id, messageId),
        inArray(
          assistantMessage.conversationId,
          db().db
            .select({ id: assistantConversation.id })
            .from(assistantConversation)
            .where(eq(assistantConversation.ownerId, ownerId)),
        ),
      ),
    )
    .returning();

  const row = rows[0];
  if (!row) return null;
  await touchConversation(row.conversationId, now);
  return toMessage(row);
}

/**
 * Delete every assistant turn in a conversation, keeping the traveller's messages.
 *
 * This is what "regenerate" needs: the alternative — deleting the last exchange
 * pair — is wrong when the traveller edited their last message, and re-running
 * the model on a history that still contains the old answer teaches it to ignore
 * its own previous turn.
 */
export async function clearAssistantTurns(ownerId: string, conversationId: string): Promise<number> {
  if (!(await ownsConversation(ownerId, conversationId))) return 0;
  const rows = await db().db
    .delete(assistantMessage)
    .where(
      and(eq(assistantMessage.conversationId, conversationId), eq(assistantMessage.role, "assistant")),
    )
    .returning({ id: assistantMessage.id });
  return rows.length;
}
