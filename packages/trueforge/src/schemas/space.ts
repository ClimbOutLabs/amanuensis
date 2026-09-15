/**
 * A space is a persistent, named, structured page the model creates and updates through the
 * `create_space` / `update_space` tools and the UI renders. Wire contracts for the
 * `/api/v1/spaces` routes.
 */
import { z } from '@hono/zod-openapi';

/**
 * Bound on the human-facing list endpoint. This only needs to keep one HTTP response and the
 * browser's render bounded, so it is a generous cap. Also the default and max accepted `limit`.
 */
export const SPACE_LIST_LIMIT = 500;

const RevisionSchema = z.number().int().nonnegative().openapi({ example: 0 });

const PageOffsetSchema = z.coerce
  .number()
  .int()
  .nonnegative()
  .optional()
  .openapi({ example: 0 })
  .describe('Records to skip before applying `limit`. Defaults to 0.');
const PageLimitSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(SPACE_LIST_LIMIT)
  .optional()
  .default(SPACE_LIST_LIMIT)
  .openapi({ example: SPACE_LIST_LIMIT })
  .describe(`Page size. Defaults to ${String(SPACE_LIST_LIMIT)}, max ${String(SPACE_LIST_LIMIT)}.`);

const ExpectedAggregateRevisionQuerySchema = z.coerce
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    'The aggregate_revision from the page being continued (requires offset). Spaces are ordered by a ' +
      'mutable field (name), so a create/update between pages can shift records across the numeric ' +
      'offset boundary. If the collection changed since that revision, the server returns 409 instead ' +
      'of a possibly duplicated or omitted page; restart from offset 0.',
  );

/**
 * `expected_aggregate_revision` only means something as a guard on a continuation read: reject up
 * front, rather than silently ignoring the revision, when a caller supplies it without the
 * `offset` it is scoped to.
 */
function requireOffsetWithExpectedAggregateRevision(
  value: { readonly offset: number | undefined; readonly expected_aggregate_revision: number | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.expected_aggregate_revision !== undefined && value.offset === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['expected_aggregate_revision'],
      message: '`expected_aggregate_revision` requires `offset` to be set; it only guards a continuation read.',
    });
  }
}

export const ListSpacesQuerySchema = z
  .object({
    limit: PageLimitSchema,
    offset: PageOffsetSchema,
    expected_aggregate_revision: ExpectedAggregateRevisionQuerySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOffsetWithExpectedAggregateRevision(
      { offset: value.offset, expected_aggregate_revision: value.expected_aggregate_revision },
      ctx,
    );
  })
  .openapi('ListSpacesQuery');

const NextOffsetSchema = z.number().int().nonnegative().nullable().openapi({ example: null });

/** Offset pagination envelope for the space list response. */
const OffsetPaginationSchema = z
  .object({ has_more: z.boolean(), next_offset: NextOffsetSchema })
  .strict()
  .openapi('SpaceOffsetPagination');

export const SpaceIdParamsSchema = z
  .object({ space_id: z.string().min(1).max(128) })
  .strict()
  .openapi('SpaceIDParams');

/**
 * Revision guard for DELETE /{space_id}, in the query the way other delete routes in this API
 * carry theirs. Unlike PUT's body guard, there is no `expected_aggregate_revision`: the aggregate
 * still advances on delete, but nothing about removing a space depends on its prior value.
 */
export const DeleteSpaceRequestQuerySchema = z
  .object({
    expected_revision: z.coerce
      .number()
      .int()
      .nonnegative()
      .openapi({ example: 1 })
      .describe('The space revision last observed by the caller. Stale values return 409 instead of deleting.'),
  })
  .strict()
  .openapi('DeleteSpaceRequestQuery');

export const SpaceStatusSchema = z.enum(['active', 'archived']).openapi('SpaceStatus');

/**
 * `markdown` is the plain option: the body is markdown text rendered as such. `html` is a
 * designed page: the body is one complete HTML document fragment (inline `<style>`, no external
 * scripts or stylesheets), rendered in a sandboxed iframe after sanitisation. Defaults to
 * `markdown` so existing spaces and callers that predate this field keep behaving exactly as
 * before.
 */
export const SpaceFormatSchema = z.enum(['markdown', 'html']).openapi('SpaceFormat');

export const SpaceContentSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    purpose: z.string().trim().min(1).max(2_000),
    status: SpaceStatusSchema,
    body: z.string().max(65_536),
    format: SpaceFormatSchema.default('markdown'),
  })
  .strict()
  .openapi('SpaceContent');

export const SpaceSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    ...SpaceContentSchema.shape,
    revision: z.number().int().positive(),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict()
  .openapi('Space');

export const CreateSpaceRequestSchema = z
  .object({ space: SpaceContentSchema, expected_aggregate_revision: RevisionSchema })
  .strict()
  .openapi('CreateSpaceRequest');
export const UpdateSpaceRequestSchema = z
  .object({
    space: SpaceContentSchema,
    expected_revision: RevisionSchema,
    expected_aggregate_revision: RevisionSchema,
  })
  .strict()
  .openapi('UpdateSpaceRequest');

const ListSpacesDataSchema = z
  .object({ spaces: z.array(SpaceSchema), aggregate_revision: RevisionSchema })
  .strict()
  .openapi('ListSpacesData');
const SpaceMutationDataSchema = z
  .object({ space: SpaceSchema, aggregate_revision: RevisionSchema })
  .strict()
  .openapi('SpaceMutationData');

export const ListSpacesResponseSchema = z
  .object({ data: ListSpacesDataSchema, pagination: OffsetPaginationSchema })
  .strict()
  .openapi('ListSpacesResponse');
export const GetSpaceResponseSchema = z.object({ data: SpaceSchema }).strict().openapi('GetSpaceResponse');
export const CreateSpaceResponseSchema = z
  .object({ data: SpaceMutationDataSchema })
  .strict()
  .openapi('CreateSpaceResponse');
export const UpdateSpaceResponseSchema = z
  .object({ data: SpaceMutationDataSchema })
  .strict()
  .openapi('UpdateSpaceResponse');

export type SpaceStatus = z.infer<typeof SpaceStatusSchema>;
export type SpaceContent = z.infer<typeof SpaceContentSchema>;
export type Space = z.infer<typeof SpaceSchema>;
export type CreateSpaceRequest = z.infer<typeof CreateSpaceRequestSchema>;
export type UpdateSpaceRequest = z.infer<typeof UpdateSpaceRequestSchema>;
