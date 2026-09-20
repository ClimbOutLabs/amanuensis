// Batch label modify + batch delete. Uses core/batch.ts::processBatches
// for chunking, AbortSignal handling, and per-item-fallback on batch failure.

import type { z } from "zod";
import {
  BatchDeleteEmailsSchema,
  BatchModifyEmailsSchema,
  BatchOpOutputSchema,
  BatchReportPhishingSchema,
} from "../../tools.js";
import { processBatches } from "../batch.js";
import { type Operation, registry } from "../registry.js";
import { apiOpts } from "../api.js";
import { fanoutMap } from "../fanout.js";

type BatchOpOutput = z.infer<typeof BatchOpOutputSchema>;

const batchModifyEmails: Operation<unknown, BatchOpOutput> = {
  name: "batch_modify_emails",
  schema: BatchModifyEmailsSchema,
  outputSchema: BatchOpOutputSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as {
      messageIds: string[];
      addLabelIds?: string[];
      removeLabelIds?: string[];
      batchSize?: number;
    };
    const batchSize = args.batchSize || 50;
    const requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
    if (args.addLabelIds) requestBody.addLabelIds = args.addLabelIds;
    if (args.removeLabelIds) requestBody.removeLabelIds = args.removeLabelIds;

    const { successes, failures, batchesTotal, batchesCompleted, itemsTotal, aborted } =
      await processBatches(
        args.messageIds,
        batchSize,
        async (batch) => {
          const results = await fanoutMap(
            batch,
            async (messageId) => {
              await ctx.gmail.users.messages.modify({
                userId: "me",
                id: messageId,
                requestBody,
              }, apiOpts(ctx));
              return { messageId, success: true };
            },
            { label: "gmail_batch_modify_fanout" },
          );
          return results;
        },
        { toolName: ctx.toolName, signal: ctx.signal },
      );

    const successCount = successes.length;
    const failureCount = failures.length;
    let resultText = "Batch label modification complete.\n";
    resultText += `Successfully processed: ${successCount} messages\n`;
    if (aborted) {
      resultText += `Aborted by client after ${batchesCompleted}/${batchesTotal} batches\n`;
    }
    if (failureCount > 0) {
      resultText += `Failed to process: ${failureCount} messages\n\n`;
      resultText += "Failed message IDs:\n";
      resultText += failures
        .map(
          (f) =>
            `- ${(f.item as string).substring(0, 16)}... (batch ${f.batchIndex}: ${f.error.message})`,
        )
        .join("\n");
    }

    return {
      content: [{ type: "text", text: resultText }],
      structuredContent: {
        action: "modify",
        successCount,
        failureCount,
        failures: failures.map((f) => ({
          messageId: f.item as string,
          error: f.error.message,
          batchIndex: f.batchIndex,
        })),
        batchesTotal,
        batchesCompleted,
        itemsTotal,
        aborted,
      },
    };
  },
};

const batchDeleteEmails: Operation<unknown, BatchOpOutput> = {
  name: "batch_delete_emails",
  schema: BatchDeleteEmailsSchema,
  outputSchema: BatchOpOutputSchema,
  scopes: ["gmail.full"],
  handler: async (input, ctx) => {
    const args = input as { messageIds: string[]; batchSize?: number };
    const batchSize = args.batchSize || 50;

    const { successes, failures, batchesTotal, batchesCompleted, itemsTotal, aborted } =
      await processBatches(
        args.messageIds,
        batchSize,
        async (batch) => {
          const results = await fanoutMap(
            batch,
            async (messageId) => {
              await ctx.gmail.users.messages.delete({
                userId: "me",
                id: messageId,
              }, apiOpts(ctx));
              return { messageId, success: true };
            },
            { label: "gmail_batch_delete_fanout" },
          );
          return results;
        },
        { toolName: ctx.toolName, signal: ctx.signal },
      );

    const successCount = successes.length;
    const failureCount = failures.length;
    let resultText = "Batch delete operation complete.\n";
    resultText += `Successfully deleted: ${successCount} messages\n`;
    if (aborted) {
      resultText += `Aborted by client after ${batchesCompleted}/${batchesTotal} batches\n`;
    }
    if (failureCount > 0) {
      resultText += `Failed to delete: ${failureCount} messages\n\n`;
      resultText += "Failed message IDs:\n";
      resultText += failures
        .map(
          (f) =>
            `- ${(f.item as string).substring(0, 16)}... (batch ${f.batchIndex}: ${f.error.message})`,
        )
        .join("\n");
    }

    return {
      content: [{ type: "text", text: resultText }],
      structuredContent: {
        action: "delete",
        successCount,
        failureCount,
        failures: failures.map((f) => ({
          messageId: f.item as string,
          error: f.error.message,
          batchIndex: f.batchIndex,
        })),
        batchesTotal,
        batchesCompleted,
        itemsTotal,
        aborted,
      },
    };
  },
};

const batchReportPhishing: Operation<unknown, BatchOpOutput> = {
  name: "batch_report_phishing",
  schema: BatchReportPhishingSchema,
  outputSchema: BatchOpOutputSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as z.infer<typeof BatchReportPhishingSchema>;
    const { successes, failures, batchesTotal, batchesCompleted, itemsTotal, aborted } =
      await processBatches(
        args.messageIds,
        args.batchSize,
        async (batch) => {
          await ctx.gmail.users.messages.batchModify({
            userId: "me",
            requestBody: { ids: batch, addLabelIds: ["SPAM"] },
          }, apiOpts(ctx));
          return batch.map((messageId) => ({ messageId, success: true }));
        },
        { toolName: ctx.toolName, signal: ctx.signal },
      );

    const limitation =
      "Gmail exposes no native phishing-report endpoint; this operation applies the SPAM label.";
    const failureEntries = failures.map((failure) => ({
      messageId: failure.item,
      error: failure.error.message,
      batchIndex: failure.batchIndex,
    }));
    return {
      content: [
        {
          type: "text",
          text: `Batch phishing approximation complete. Marked as spam: ${successes.length}. Failed: ${failures.length}.${aborted ? ` Aborted by client after ${batchesCompleted}/${batchesTotal} batches.` : ""}\n${limitation}`,
        },
      ],
      structuredContent: {
        action: "report_phishing",
        successCount: successes.length,
        failureCount: failures.length,
        failures: failureEntries,
        batchesTotal,
        batchesCompleted,
        itemsTotal,
        aborted,
      },
    };
  },
};

registry.register(batchModifyEmails);
registry.register(batchDeleteEmails);
registry.register(batchReportPhishing);
