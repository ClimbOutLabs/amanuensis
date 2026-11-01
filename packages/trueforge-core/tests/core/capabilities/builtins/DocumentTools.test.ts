import {
  buildDocumentsInstruction,
  CREATE_DOCUMENT_REPORT_TOOL_NAME,
  DOCUMENT_REPORT_TOOL_NAMES,
  DocumentTools,
  SUMMARIZE_NET_WORTH_TOOL_NAME,
} from '../../../../src/core/capabilities/builtins/DocumentTools';
import { InstructionBuilder } from '../../../../src/core/InstructionBuilder';
import type { CallToolResponse } from '../../../../src/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../../src/documents/toolContract';
import { makeSilentLogger, makeStubPublicSandbox } from '../../harnessMocks';

describe('DocumentTools guidance', () => {
  it('names staged sandbox paths as valid for the extraction tool in its schema', async () => {
    const tools = new DocumentTools({
      sandbox: makeStubPublicSandbox(),
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });
    const listed = await tools.listTools();
    const tool = listed.result.tools.find(candidate => candidate.name === EXTRACT_DOCUMENT_TEXT_TOOL_NAME);
    const schemaText = JSON.stringify(tool?.inputSchema ?? {});
    expect(schemaText).toContain('Paths from the Uploaded files announcement');
    expect(schemaText).toContain('staged path of a file placed in the sandbox');
    expect(schemaText).toContain('attachment note in a tool result');
  });

  it('tells the model to read a staged attachment with the extraction tool at its staged path', () => {
    const builder = new InstructionBuilder('system-prompt');
    buildDocumentsInstruction(builder);
    const text = builder.build();
    expect(text).toContain(
      'A file staged from an email or chat attachment is read with documents/extract_document_text using its staged path, the same as an announced upload.',
    );
    for (const format of ['Word .docx/.doc', 'Excel .xlsx/.xls', 'PowerPoint .pptx', '.eml or .msg']) {
      expect(text).toContain(format);
    }
    expect(text).toContain('Unreadable or unsupported files produce issues, never guesses.');
    expect(text).toContain('Do not use the language model as a PDF/OCR parser or invent missing values.');
  });

  it('offers the report tools to a chat turn', async () => {
    const tools = new DocumentTools({
      sandbox: makeStubPublicSandbox(),
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });
    const names = (await tools.listTools()).result.tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([...DOCUMENT_REPORT_TOOL_NAMES, EXTRACT_DOCUMENT_TEXT_TOOL_NAME]));
  });

  it('leaves the report tools out when a run withholds them, and keeps extraction', async () => {
    const tools = new DocumentTools({
      sandbox: makeStubPublicSandbox(),
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      withheldTools: DOCUMENT_REPORT_TOOL_NAMES,
    });
    const names = (await tools.listTools()).result.tools.map(tool => tool.name);
    expect(names).toEqual([EXTRACT_DOCUMENT_TEXT_TOOL_NAME]);
  });

  it('does not mention a withheld report tool in the guidance', () => {
    const builder = new InstructionBuilder('system-prompt');
    buildDocumentsInstruction(builder, { withheldTools: DOCUMENT_REPORT_TOOL_NAMES });
    const text = builder.build();
    expect(text).not.toContain(CREATE_DOCUMENT_REPORT_TOOL_NAME);
    expect(text).toContain('Unreadable or unsupported files produce issues, never guesses.');
  });
});

function errorOf(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected a tool result, got an approval request');
  }
  expect(response.result.isError).toBe(true);
  const parsed: unknown = JSON.parse(
    response.result.content.map(block => (block.type === 'text' ? block.text : '')).join(''),
  );
  if (typeof parsed !== 'object' || parsed === null || !('error' in parsed) || typeof parsed.error !== 'string') {
    throw new Error('expected an error result');
  }
  return parsed.error;
}

describe('DocumentTools report failures', () => {
  const approval = { status: 'allow', scope: 'once' } as const;
  const rawFailure = new Error('slot 7 not found: /var/lib/aman/slots/7/workspace EIO');

  it('shows a fixed sentence, never the raw error, when a report cannot be stored', async () => {
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'writeArtifact').mockRejectedValue(rawFailure);
    const tools = new DocumentTools({ sandbox, tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() });

    const response = await tools.callTool(
      {
        name: CREATE_DOCUMENT_REPORT_TOOL_NAME,
        arguments: { title: 'Summary', summary: 'Draft', sections: [], notes: [] },
      },
      approval,
    );

    const error = errorOf(response);
    expect(error).toBe(
      'The report could not be made. Try again; if it keeps failing, check that the sandbox is ready under Settings, Sandbox.',
    );
    expect(error).not.toContain('/var/lib');
  });

  it('shows a fixed sentence when the net-worth report cannot be stored', async () => {
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'writeArtifact').mockRejectedValue(rawFailure);
    const tools = new DocumentTools({ sandbox, tracing: NOOP_AGENT_TRACING, logger: makeSilentLogger() });

    const response = await tools.callTool(
      { name: SUMMARIZE_NET_WORTH_TOOL_NAME, arguments: { file_paths: [], observations: [], title: 'Net worth' } },
      approval,
    );

    expect(errorOf(response)).not.toContain('slot 7');
  });

  it('still shows the renderer reason for a report it cannot draw, so the model can fix the call', async () => {
    const tools = new DocumentTools({
      sandbox: makeStubPublicSandbox(),
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });

    const response = await tools.callTool(
      {
        name: CREATE_DOCUMENT_REPORT_TOOL_NAME,
        arguments: {
          title: 'Summary',
          summary: 'Draft',
          sections: ['A', 'B', 'C'].map(heading => ({ heading, rows: [] })),
          notes: [],
        },
      },
      approval,
    );

    expect(errorOf(response)).toMatch(/^Report exceeds the compact mode limits/);
  });
});
