import { z } from 'zod';

export const MAX_TASK_CHECKLIST_ITEMS = 50;

const TaskChecklistItemSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    text: z.string().trim().min(1).max(1_000),
    done: z.boolean(),
  })
  .strict();

const TaskChecklistItemsSchema = z
  .array(TaskChecklistItemSchema)
  .max(MAX_TASK_CHECKLIST_ITEMS)
  .superRefine((items, context) => {
    const ids = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `duplicate checklist item id: ${item.id}`,
        });
      }
      ids.add(item.id);
    }
  });

export const TaskChecklistSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    items: TaskChecklistItemsSchema,
  })
  .strict();

export const ReplaceTaskChecklistRequestSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    items: TaskChecklistItemsSchema,
  })
  .strict();

export type TaskChecklistItem = z.infer<typeof TaskChecklistItemSchema>;
export type TaskChecklist = z.infer<typeof TaskChecklistSchema>;
export type ReplaceTaskChecklistRequest = z.infer<typeof ReplaceTaskChecklistRequestSchema>;

export function emptyTaskChecklist(): TaskChecklist {
  return { revision: 0, items: [] };
}

export function parseStoredTaskChecklist(value: unknown): TaskChecklist {
  if (value === null || value === undefined) {
    return emptyTaskChecklist();
  }
  return TaskChecklistSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
}
