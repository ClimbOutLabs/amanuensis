import {
  buildDocumentsInstruction,
  CREATE_DOCUMENT_REPORT_TOOL_NAME,
  DOCUMENT_REPORT_TOOL_NAMES,
  DocumentTools,
} from '../../../../src/core/capabilities/builtins/DocumentTools';
import { InstructionBuilder } from '../../../../src/core/InstructionBuilder';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../../src/documents/toolContract';
import { makeStubPublicSandbox } from '../../harnessMocks';

describe('DocumentTools guidance', () => {
  it('names staged sandbox paths as valid for the extraction tool in its schema', async () => {
    const tools = new DocumentTools(makeStubPublicSandbox(), NOOP_AGENT_TRACING);
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
    const tools = new DocumentTools(makeStubPublicSandbox(), NOOP_AGENT_TRACING);
    const names = (await tools.listTools()).result.tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([...DOCUMENT_REPORT_TOOL_NAMES, EXTRACT_DOCUMENT_TEXT_TOOL_NAME]));
  });

  it('leaves the report tools out when a run withholds them, and keeps extraction', async () => {
    const tools = new DocumentTools(makeStubPublicSandbox(), NOOP_AGENT_TRACING, undefined, DOCUMENT_REPORT_TOOL_NAMES);
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
