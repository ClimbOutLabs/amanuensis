// Filter management ops. Wraps src/filter-manager.ts low-level helpers.

import type { z } from "zod";
import {
  createFilter,
  deleteFilter,
  filterTemplates,
  getFilter,
  listFilters,
} from "../../filter-manager.js";
import {
  CreateFilterFromTemplateSchema,
  CreateFilterOutputSchema,
  CreateFilterSchema,
  DeleteFilterOutputSchema,
  DeleteFilterSchema,
  GetFilterOutputSchema,
  GetFilterSchema,
  ListEmailLabelsSchema,
  ListFiltersOutputSchema,
} from "../../tools.js";
import { listMeta } from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";

type ListFiltersOutput = z.infer<typeof ListFiltersOutputSchema>;
type GetFilterOutput = z.infer<typeof GetFilterOutputSchema>;
type CreateFilterOutput = z.infer<typeof CreateFilterOutputSchema>;
type DeleteFilterOutput = z.infer<typeof DeleteFilterOutputSchema>;

const createFilterOp: Operation<unknown, CreateFilterOutput> = {
  name: "create_filter",
  schema: CreateFilterSchema,
  outputSchema: CreateFilterOutputSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (input, ctx) => {
    const args = input as { criteria: any; action: any };
    const result = await createFilter(ctx.gmail, args.criteria, args.action, ctx.signal);

    const criteriaText = Object.entries(args.criteria)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");

    const actionText = Object.entries(args.action)
      .filter(
        ([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
      )
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join(", ");

    return {
      content: [
        {
          type: "text",
          text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
        },
      ],
      structuredContent: {
        id: result.id ?? "",
        criteria: args.criteria,
        action: args.action,
      },
    };
  },
};

const listFiltersOp: Operation<unknown, ListFiltersOutput> = {
  name: "list_filters",
  // No dedicated schema in tools.ts — list_filters takes no args. Reuse the
  // empty schema used by list_email_labels for shape parity.
  schema: ListEmailLabelsSchema,
  outputSchema: ListFiltersOutputSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (_input, ctx) => {
    const result = await listFilters(ctx.gmail, ctx.signal);
    const filters = result.filters;

    if (filters.length === 0) {
      return {
        content: [{ type: "text", text: "No filters found." }],
        structuredContent: { count: 0, filters: [], ...listMeta(0) },
      };
    }

    const filtersText = filters
      .map((filter: any) => {
        const criteriaEntries = Object.entries(filter.criteria || {})
          .filter(([_, value]) => value !== undefined)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ");

        const actionEntries = Object.entries(filter.action || {})
          .filter(
            ([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
          )
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
          .join(", ");

        return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${result.count} filters:\n\n${filtersText}`,
        },
      ],
      structuredContent: {
        count: result.count,
        filters: filters.map((f: any) => ({
          id: String(f.id ?? ""),
          criteria: f.criteria,
          action: f.action,
        })),
        // Filters are fully enumerated in one call — never truncated.
        ...listMeta(result.count),
      },
    };
  },
};

const getFilterOp: Operation<unknown, GetFilterOutput> = {
  name: "get_filter",
  schema: GetFilterSchema,
  outputSchema: GetFilterOutputSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (input, ctx) => {
    const args = input as { filterId: string };
    const result = await getFilter(ctx.gmail, args.filterId, ctx.signal);

    const criteriaText = Object.entries(result.criteria || {})
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");

    const actionText = Object.entries(result.action || {})
      .filter(
        ([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
      )
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join(", ");

    return {
      content: [
        {
          type: "text",
          text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
        },
      ],
      structuredContent: {
        id: String(result.id ?? args.filterId),
        criteria: result.criteria as Record<string, unknown> | undefined,
        action: result.action as Record<string, unknown> | undefined,
      },
    };
  },
};

const deleteFilterOp: Operation<unknown, DeleteFilterOutput> = {
  name: "delete_filter",
  schema: DeleteFilterSchema,
  outputSchema: DeleteFilterOutputSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (input, ctx) => {
    const args = input as { filterId: string };
    const result = await deleteFilter(ctx.gmail, args.filterId, ctx.signal);
    return {
      content: [{ type: "text", text: result.message }],
      structuredContent: { id: args.filterId, status: "deleted", message: result.message },
    };
  },
};

const createFilterFromTemplate: Operation<unknown, CreateFilterOutput> = {
  name: "create_filter_from_template",
  schema: CreateFilterFromTemplateSchema,
  outputSchema: CreateFilterOutputSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (input, ctx) => {
    const args = input as { template: string; parameters: any };
    const template = args.template;
    const params = args.parameters;

    let filterConfig: { criteria: any; action: any };
    switch (template) {
      case "fromSender":
        if (!params.senderEmail) throw new Error("senderEmail is required for fromSender template");
        filterConfig = filterTemplates.fromSender(
          params.senderEmail,
          params.labelIds,
          params.archive,
        );
        break;
      case "withSubject":
        if (!params.subjectText)
          throw new Error("subjectText is required for withSubject template");
        filterConfig = filterTemplates.withSubject(
          params.subjectText,
          params.labelIds,
          params.markAsRead,
        );
        break;
      case "withAttachments":
        filterConfig = filterTemplates.withAttachments(params.labelIds);
        break;
      case "largeEmails":
        if (!params.sizeInBytes)
          throw new Error("sizeInBytes is required for largeEmails template");
        filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
        break;
      case "containingText":
        if (!params.searchText)
          throw new Error("searchText is required for containingText template");
        filterConfig = filterTemplates.containingText(
          params.searchText,
          params.labelIds,
          params.markImportant,
        );
        break;
      case "mailingList":
        if (!params.listIdentifier)
          throw new Error("listIdentifier is required for mailingList template");
        filterConfig = filterTemplates.mailingList(
          params.listIdentifier,
          params.labelIds,
          params.archive,
        );
        break;
      default:
        throw new Error(`Unknown template: ${template}`);
    }

    const result = await createFilter(
        ctx.gmail,
        filterConfig.criteria,
        filterConfig.action,
        ctx.signal,
      );
    return {
      content: [
        {
          type: "text",
          text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`,
        },
      ],
      structuredContent: {
        id: String(result.id ?? ""),
        criteria: filterConfig.criteria,
        action: filterConfig.action,
      },
    };
  },
};

registry.register(createFilterOp);
registry.register(listFiltersOp);
registry.register(getFilterOp);
registry.register(deleteFilterOp);
registry.register(createFilterFromTemplate);
