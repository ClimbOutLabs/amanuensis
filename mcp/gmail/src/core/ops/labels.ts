// Label-management ops: list_email_labels + 4 CRUD ops.
// Wraps the existing low-level helpers in src/label-manager.ts.

import type { z } from "zod";
import {
  createLabel,
  deleteLabel,
  type GmailLabel,
  getOrCreateLabel,
  listLabels,
  updateLabel,
} from "../../label-manager.js";
import {
  CreateLabelSchema,
  DeleteLabelSchema,
  GetOrCreateLabelSchema,
  LabelDeleteOutputSchema,
  LabelMutationOutputSchema,
  ListEmailLabelsOutputSchema,
  ListEmailLabelsSchema,
  UpdateLabelSchema,
} from "../../tools.js";
import { listMeta } from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";

type ListLabelsOutput = z.infer<typeof ListEmailLabelsOutputSchema>;
type LabelMutationOutput = z.infer<typeof LabelMutationOutputSchema>;
type LabelDeleteOutput = z.infer<typeof LabelDeleteOutputSchema>;

const listEmailLabels: Operation<unknown, ListLabelsOutput> = {
  name: "list_email_labels",
  schema: ListEmailLabelsSchema,
  outputSchema: ListEmailLabelsOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
  handler: async (_input, ctx) => {
    const labelResults = await listLabels(ctx.gmail, ctx.signal);
    const systemLabels = labelResults.system;
    const userLabels = labelResults.user;

    const text =
      `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
      "System Labels:\n" +
      systemLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join("\n") +
      "\nUser Labels:\n" +
      userLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join("\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: {
        count: labelResults.count,
        system: systemLabels.map((l: GmailLabel) => ({
          id: l.id ?? "",
          name: l.name ?? "",
          type: l.type ?? undefined,
        })),
        user: userLabels.map((l: GmailLabel) => ({
          id: l.id ?? "",
          name: l.name ?? "",
          type: l.type ?? undefined,
        })),
        // Labels are fully enumerated in one call — never truncated.
        ...listMeta(labelResults.count.total),
      },
    };
  },
};

const createLabelOp: Operation<unknown, LabelMutationOutput> = {
  name: "create_label",
  schema: CreateLabelSchema,
  outputSchema: LabelMutationOutputSchema,
  scopes: ["gmail.modify", "gmail.labels"],
  handler: async (input, ctx) => {
    const args = input as {
      name: string;
      messageListVisibility?: string;
      labelListVisibility?: string;
    };
    const result = await createLabel(ctx.gmail, args.name, {
      messageListVisibility: args.messageListVisibility,
      labelListVisibility: args.labelListVisibility,
    }, ctx.signal);
    return {
      content: [
        {
          type: "text",
          text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
        },
      ],
      structuredContent: {
        id: result.id ?? "",
        name: result.name ?? "",
        type: result.type ?? "user",
      },
    };
  },
};

const updateLabelOp: Operation<unknown, LabelMutationOutput> = {
  name: "update_label",
  schema: UpdateLabelSchema,
  outputSchema: LabelMutationOutputSchema,
  scopes: ["gmail.modify", "gmail.labels"],
  handler: async (input, ctx) => {
    const args = input as {
      id: string;
      name?: string;
      messageListVisibility?: string;
      labelListVisibility?: string;
    };
    const updates: { name?: string; messageListVisibility?: string; labelListVisibility?: string } =
      {};
    if (args.name) updates.name = args.name;
    if (args.messageListVisibility) updates.messageListVisibility = args.messageListVisibility;
    if (args.labelListVisibility) updates.labelListVisibility = args.labelListVisibility;

    const result = await updateLabel(ctx.gmail, args.id, updates, ctx.signal);
    return {
      content: [
        {
          type: "text",
          text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
        },
      ],
      structuredContent: {
        id: result.id ?? "",
        name: result.name ?? "",
        type: result.type ?? "user",
      },
    };
  },
};

const deleteLabelOp: Operation<unknown, LabelDeleteOutput> = {
  name: "delete_label",
  schema: DeleteLabelSchema,
  outputSchema: LabelDeleteOutputSchema,
  scopes: ["gmail.modify", "gmail.labels"],
  handler: async (input, ctx) => {
    const args = input as { id: string };
    const result = await deleteLabel(ctx.gmail, args.id, ctx.signal);
    return {
      content: [{ type: "text", text: result.message }],
      structuredContent: { id: args.id, status: "deleted", message: result.message },
    };
  },
};

const getOrCreateLabelOp: Operation<unknown, LabelMutationOutput> = {
  name: "get_or_create_label",
  schema: GetOrCreateLabelSchema,
  outputSchema: LabelMutationOutputSchema,
  scopes: ["gmail.modify", "gmail.labels"],
  handler: async (input, ctx) => {
    const args = input as {
      name: string;
      messageListVisibility?: string;
      labelListVisibility?: string;
    };
    const result = await getOrCreateLabel(
      ctx.gmail,
      args.name,
      {
        messageListVisibility: args.messageListVisibility,
        labelListVisibility: args.labelListVisibility,
      },
      ctx.signal,
    );

    const action =
      result.type === "user" && result.name === args.name ? "found existing" : "created new";

    return {
      content: [
        {
          type: "text",
          text: `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
        },
      ],
      structuredContent: {
        id: result.id ?? "",
        name: result.name ?? "",
        type: result.type ?? "user",
      },
    };
  },
};

registry.register(listEmailLabels);
registry.register(createLabelOp);
registry.register(updateLabelOp);
registry.register(deleteLabelOp);
registry.register(getOrCreateLabelOp);
