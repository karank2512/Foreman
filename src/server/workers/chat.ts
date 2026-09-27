import type { MessageClassification, MessageRole, Prisma } from "@prisma/client";
import { recordActivity } from "@/server/activity";
import { assertCan } from "@/server/auth/permissions";
import type { SessionContext } from "@/server/auth/types";
import { db, toJson } from "@/server/db";
import { MessageClassificationSchema, type MessageClassificationResult } from "@/server/domain";
import { conflict, invalid } from "@/server/errors";
import { llm, type ChatMessage } from "@/server/models";
import { assertOrgActive, assertWithinBudget } from "@/server/security";
import { buildChatContext, renderContextForPrompt, type WorkerChatContext } from "./chat-context";
import { mockClassify, mockQuestionReply, normalizeInstruction, specChangeReply, temporaryInstructionReply } from "./chat-mock";
import { deriveSpecChange } from "./chat-spec-change";
import { clip, loadWorker, replaceHref, type WorkerRecord } from "./shared";
import { createProposedVersion } from "./versions";

/**
 * Talk to a worker. Every message is classified first: a QUESTION is answered from the worker's own record, a
 * TEMPORARY_INSTRUCTION is parked until the next run picks it up (runtime.enqueueRun consumes it), and a
 * SPEC_CHANGE becomes a proposed version the manager must approve — the worker never rewrites itself.
 */

const MAX_MESSAGE_CHARS = 4_000;
const REPLY_MAX_TOKENS = 600;

export interface WorkerChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  classification: MessageClassification | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface SendMessageResult {
  userMessageId: string;
  replyMessageId: string;
  classification: MessageClassification;
  proposedVersionId?: string;
}

const CLASSIFY_SYSTEM = [
  "You classify messages a manager sends to one of their AI workers. Reply with JSON only.",
  "- QUESTION: asks for information about the work, its status, results, costs or reasoning.",
  '- TEMPORARY_INSTRUCTION: a one-off adjustment for the next run only ("this time", "for the next run", "today", a plain imperative).',
  '- SPEC_CHANGE: a lasting change to how the worker works — schedule, deliverable format, number of records, scope, quality bar ("from now on", "always", "going forward", "change the schedule").',
  "Fields: classification, confidence (0..1), normalizedInstruction (instructions and spec changes only: one imperative sentence in plain English), reasoning (one sentence).",
].join("\n");

function classifyPrompt(ctx: WorkerChatContext, content: string): string {
  return [
    `Worker: ${ctx.worker.name}, ${ctx.worker.title} on “${ctx.jobTitle}”.`,
    `Deliverable: ${ctx.spec.deliverable.title} (${ctx.spec.deliverable.format}), schedule ${ctx.cadence.kind}.`,
    "",
    "Message from the manager:",
    `"""${content}"""`,
  ].join("\n");
}

function normalizeClassification(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (typeof o.classification === "string") o.classification = o.classification.toUpperCase().replace(/[\s-]+/g, "_");
  if (typeof o.confidence === "number") o.confidence = Math.min(1, Math.max(0, o.confidence));
  else o.confidence = 0.5;
  if (typeof o.normalizedInstruction !== "string" || o.normalizedInstruction.trim().length === 0) delete o.normalizedInstruction;
  if (typeof o.reasoning !== "string") o.reasoning = "";
  return o;
}

function replySystem(s: SessionContext, ctx: WorkerChatContext): string {
  return [
    `You are ${ctx.worker.name}, ${ctx.worker.title} — an AI worker hired by ${s.organizationName} for the job “${ctx.jobTitle}”. You are chatting with your manager, ${s.name}.`,
    "Answer in the first person as the worker, in two to five sentences. Be specific and honest: cite real run titles, dates, scores, counts and costs from the facts below, and say so plainly when you do not know something. Never invent facts. No markdown headings or bullet lists.",
    "",
    "Facts about you and your work:",
    renderContextForPrompt(ctx),
  ].join("\n");
}

async function answerQuestion(s: SessionContext, worker: WorkerRecord, ctx: WorkerChatContext, content: string): Promise<{ text: string; simulated: boolean }> {
  const history: ChatMessage[] = ctx.recentMessages.map((m) => (m.role === "USER" ? { role: "user", content: m.content } : { role: "assistant", content: m.content }));
  const result = await llm.generateText(
    {
      tier: "standard",
      system: replySystem(s, ctx),
      messages: [...history, { role: "user", content }],
      maxOutputTokens: REPLY_MAX_TOKENS,
      mock: () => ({ text: mockQuestionReply(ctx, content) }),
    },
    { organizationId: s.organizationId, purpose: "chat.reply", workerId: worker.id, jobId: worker.jobId },
  );
  const text = result.text.trim();
  return { text: text.length > 0 ? text : mockQuestionReply(ctx, content), simulated: result.simulated };
}

async function persistExchange(args: {
  s: SessionContext;
  worker: WorkerRecord;
  user: { content: string; classification: MessageClassification; instructionActive: boolean; proposedVersionId?: string; metadata: Record<string, unknown> };
  reply: { content: string; metadata: Record<string, unknown> };
}): Promise<{ userMessageId: string; replyMessageId: string }> {
  const { s, worker } = args;
  const base = { organizationId: s.organizationId, workerId: worker.id } satisfies Partial<Prisma.WorkerMessageUncheckedCreateInput>;
  return db.$transaction(async (tx) => {
    const user = await tx.workerMessage.create({
      data: {
        ...base,
        role: "USER",
        content: args.user.content,
        classification: args.user.classification,
        instructionActive: args.user.instructionActive,
        proposedVersionId: args.user.proposedVersionId ?? null,
        userId: s.userId,
        metadata: toJson(args.user.metadata),
      },
      select: { id: true, createdAt: true },
    });
    // The reply is stamped one millisecond later so chronological order never depends on clock resolution.
    const reply = await tx.workerMessage.create({
      data: {
        ...base,
        role: "WORKER",
        content: args.reply.content,
        classification: args.user.classification,
        proposedVersionId: args.user.proposedVersionId ?? null,
        metadata: toJson(args.reply.metadata),
        createdAt: new Date(user.createdAt.getTime() + 1),
      },
      select: { id: true },
    });
    return { userMessageId: user.id, replyMessageId: reply.id };
  });
}

export async function sendMessageToWorker(s: SessionContext, workerId: string, content: string): Promise<SendMessageResult> {
  assertCan(s, "workers.chat");
  await assertOrgActive(s.organizationId);
  await assertWithinBudget(s.organizationId);
  const message = content.trim();
  if (message.length === 0) throw invalid("Write a message first");
  if (message.length > MAX_MESSAGE_CHARS) throw invalid(`Messages are at most ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters`);

  const worker = await loadWorker(s.organizationId, workerId);
  if (worker.status === "RETIRED") throw conflict(`${worker.name} has been retired and no longer takes messages`);
  const ctx = await buildChatContext(s.organizationId, worker);

  const classified = await llm.generateObject<MessageClassificationResult>(
    {
      tier: "fast",
      system: CLASSIFY_SYSTEM,
      prompt: classifyPrompt(ctx, message),
      schema: MessageClassificationSchema,
      schemaName: "MessageClassification",
      normalize: normalizeClassification,
      mock: () => mockClassify(message),
    },
    { organizationId: s.organizationId, purpose: "chat.classify", workerId: worker.id, jobId: worker.jobId },
  );
  const classification = classified.object.classification;
  const normalized = classified.object.normalizedInstruction?.trim() || normalizeInstruction(message);
  const userMetadata: Record<string, unknown> = {
    confidence: classified.object.confidence,
    reasoning: classified.object.reasoning,
    simulated: classified.simulated,
    ...(classification === "QUESTION" ? {} : { normalizedInstruction: normalized }),
  };

  if (classification === "QUESTION") {
    const answer = await answerQuestion(s, worker, ctx, message);
    const ids = await persistExchange({
      s,
      worker,
      user: { content: message, classification, instructionActive: false, metadata: userMetadata },
      reply: { content: answer.text, metadata: { simulated: answer.simulated } },
    });
    return { ...ids, classification };
  }

  if (classification === "TEMPORARY_INSTRUCTION") {
    const ids = await persistExchange({
      s,
      worker,
      user: { content: message, classification, instructionActive: true, metadata: userMetadata },
      // The acknowledgement is a template; "Simulated" is true only when the classification ran on the mock provider.
      reply: { content: temporaryInstructionReply(ctx, normalized), metadata: { simulated: classified.simulated, normalizedInstruction: normalized } },
    });
    await recordActivity({
      organizationId: s.organizationId,
      type: "INSTRUCTION_RECEIVED",
      title: `${s.name} gave ${worker.name} a one-off instruction`,
      detail: clip(normalized, 200),
      workerId: worker.id,
      jobId: worker.jobId,
      actorType: "USER",
      actorName: s.name,
    });
    return { ...ids, classification };
  }

  // SPEC_CHANGE: derive the revised design first so a bad instruction leaves nothing half-written behind. The
  // starting point carries the worker's LIVE schedule, so applying the proposal never undoes a schedule change.
  const current = { ...ctx.blueprint, schedule: ctx.cadence };
  const derived = deriveSpecChange({ blueprint: current, spec: ctx.spec, instruction: normalized });
  const proposed = await createProposedVersion({
    organizationId: s.organizationId,
    workerId: worker.id,
    blueprint: derived.blueprint,
    changeReason: "SPEC_CHANGE",
    changeSummary: normalized,
    userId: s.userId,
  });
  const href = replaceHref(worker.id, proposed.versionId);
  const reply = specChangeReply({
    ctx,
    version: proposed.version,
    changes: derived.changes,
    perRunBefore: ctx.blueprint.costEstimate.perRunUsd,
    perRunAfter: derived.blueprint.costEstimate.perRunUsd,
  });
  const ids = await persistExchange({
    s,
    worker,
    user: { content: message, classification, instructionActive: false, proposedVersionId: proposed.versionId, metadata: userMetadata },
    reply: {
      content: reply,
      metadata: { simulated: classified.simulated, proposedVersionId: proposed.versionId, version: proposed.version, href, changes: derived.changes },
    },
  });
  return { ...ids, classification, proposedVersionId: proposed.versionId };
}

/** The conversation, oldest first — the last `limit` messages (default 100). */
export async function listMessages(organizationId: string, workerId: string, limit = 100): Promise<WorkerChatMessage[]> {
  const worker = await loadWorker(organizationId, workerId);
  const take = Math.min(500, Math.max(1, Math.floor(limit)));
  const rows = await db.workerMessage.findMany({
    where: { organizationId, workerId: worker.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: { id: true, role: true, content: true, classification: true, metadata: true, createdAt: true },
  });
  return rows.reverse().map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    classification: m.classification,
    metadata: typeof m.metadata === "object" && m.metadata !== null && !Array.isArray(m.metadata) ? (m.metadata as Record<string, unknown>) : null,
    createdAt: m.createdAt.toISOString(),
  }));
}
