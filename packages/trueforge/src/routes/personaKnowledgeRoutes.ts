import { createRoute, z } from '@hono/zod-openapi';

import { RequestErrorResponseSchema } from '../schemas/errors';
import { PersonaIdParamsSchema } from '../schemas/persona';
import {
  CreateKnowledgeDocumentRequestSchema,
  DeleteKnowledgeDocumentResponseSchema,
  GetKnowledgeDocumentResponseSchema,
  GetKnowledgeEmbeddingModelResponseSchema,
  ListKnowledgeDocumentsResponseSchema,
} from '../schemas/personaKnowledge';
import { OpenApiTag } from './openapiTags';

const KnowledgeDocumentParamsSchema = z
  .object({
    persona_id: z.string().min(1).max(64).describe('Stable persona identifier.'),
    document_id: z.string().min(1).max(64).describe('Stable knowledge document identifier.'),
  })
  .openapi('PersonaKnowledgeDocumentParams');

const protectedResponses = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'OIDC is configured and the request has no valid session cookie.',
  },
};

const notFoundResponse = {
  404: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'No such persona for this user.',
  },
};

const serverErrorResponse = {
  500: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'The knowledge library storage is unavailable; the message is safe to show.',
  },
};

export const listPersonaKnowledgeRoute = createRoute({
  method: 'get',
  path: '/{persona_id}/knowledge',
  tags: [OpenApiTag.PERSONAS],
  summary: 'List persona knowledge documents',
  description: 'Returns the documents in the persona’s knowledge library with their indexing status.',
  'x-fern-sdk-group-name': ['personas'],
  'x-fern-sdk-method-name': 'list_knowledge',
  request: { params: PersonaIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListKnowledgeDocumentsResponseSchema } },
      description: 'Knowledge documents.',
    },
    ...notFoundResponse,
    ...serverErrorResponse,
    ...protectedResponses,
  },
});

export const createPersonaKnowledgeRoute = createRoute({
  method: 'post',
  path: '/{persona_id}/knowledge',
  tags: [OpenApiTag.PERSONAS],
  summary: 'Add a knowledge document',
  description:
    'Adds a file, saved link, or pasted text to the persona’s knowledge library. Indexing runs in the background; the document reports its status until it is searchable.',
  'x-fern-sdk-group-name': ['personas'],
  'x-fern-sdk-method-name': 'create_knowledge',
  request: {
    params: PersonaIdParamsSchema,
    body: { content: { 'application/json': { schema: CreateKnowledgeDocumentRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetKnowledgeDocumentResponseSchema } },
      description: 'Created knowledge document.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid document: unsupported file type, bad link, or oversized payload.',
    },
    ...notFoundResponse,
    ...serverErrorResponse,
    ...protectedResponses,
  },
});

export const deletePersonaKnowledgeRoute = createRoute({
  method: 'delete',
  path: '/{persona_id}/knowledge/{document_id}',
  tags: [OpenApiTag.PERSONAS],
  summary: 'Delete a knowledge document',
  description: 'Removes the document and all of its indexed chunks from the persona’s library.',
  'x-fern-sdk-group-name': ['personas'],
  'x-fern-sdk-method-name': 'delete_knowledge',
  request: { params: KnowledgeDocumentParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteKnowledgeDocumentResponseSchema } },
      description: 'Deleted.',
    },
    ...notFoundResponse,
    ...serverErrorResponse,
    ...protectedResponses,
  },
});

export const getPersonaKnowledgeEmbeddingModelRoute = createRoute({
  method: 'get',
  path: '/{persona_id}/knowledge/embedding-model',
  tags: [OpenApiTag.PERSONAS],
  summary: 'Get the knowledge search model status',
  description: 'Reports the one-time search model download in plain English.',
  'x-fern-sdk-group-name': ['personas'],
  'x-fern-sdk-method-name': 'get_knowledge_embedding_model',
  request: { params: PersonaIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetKnowledgeEmbeddingModelResponseSchema } },
      description: 'Search model status.',
    },
    ...notFoundResponse,
    ...protectedResponses,
  },
});
