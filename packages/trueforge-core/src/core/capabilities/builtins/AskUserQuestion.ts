import { z } from 'zod';
import { ClientSideTool } from '../../mcp/ClientSideTool';
import { toolResultResponse } from '../../mcp/IMCPServer';
import { defineTool, type ToolDefinition } from '../../mcp/LocalToolMCP';
import type { AgentCapability } from '../AgentCapability';
import { OPENUI_SECTION_TAG } from './OpenUI';

const ASK_USER_QUESTION_SERVER_ID = 'ask-user-question';
export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

const askUserQuestionInputSchema = z.object({
  question: z.string().describe('The question to ask the user.'),
  options: z
    .array(z.string())
    .min(0)
    .max(5)
    .describe(
      '0-5 mutually exclusive choices, each mapping to a distinct outcome. A free-text input is always rendered alongside.',
    ),
});

export class AskUserQuestion extends ClientSideTool {
  readonly name = ASK_USER_QUESTION_SERVER_ID;
  readonly displayName = 'AskUserQuestion';
  override readonly tracingEnabled = false;

  protected getTools(): ToolDefinition[] {
    return [
      defineTool({
        name: ASK_USER_QUESTION_TOOL_NAME,
        description: [
          'Only ask the user when a decision or clarification changes what you do next. Never ask permission to start or continue work the user already requested.',
          'Give 0-5 options. Each is a distinct, mutually exclusive outcome; a combined choice is its own option. The user picks exactly one. Every option commits the user to a specific outcome: no "Other" and no free-text option.',
          'Put a recommended option first with the exact suffix " (Recommended)", and only when one clearly stands out.',
          `Do not use <${OPENUI_SECTION_TAG}> to ask a question.`,
        ].join('\n'),
        schema: askUserQuestionInputSchema,
        handler: () =>
          Promise.resolve(
            toolResultResponse({
              text: 'This tool requires client-side execution and cannot be run server-side.',
              isError: true,
            }),
          ),
      }),
    ];
  }
}

export function askUserQuestion(): AgentCapability {
  return {
    systemToolSets: [new AskUserQuestion()],
  };
}
