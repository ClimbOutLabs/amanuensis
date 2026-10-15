// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MonacoEditorCore } from '@/atoms/MonacoEditorCore.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';

const monacoMocks = vi.hoisted(() => {
  let changeListener: (() => void) | undefined;
  let sizeListener: (() => void) | undefined;

  const changeDisposable = { dispose: vi.fn() };
  const sizeDisposable = { dispose: vi.fn() };
  const editor = {
    getValue: vi.fn(() => 'initial value'),
    setValue: vi.fn(),
    getContentHeight: vi.fn(() => 72),
    onDidChangeModelContent: vi.fn((listener: () => void) => {
      changeListener = listener;
      return changeDisposable;
    }),
    onDidContentSizeChange: vi.fn((listener: () => void) => {
      sizeListener = listener;
      return sizeDisposable;
    }),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
    layout: vi.fn(),
  };
  const editorApi = {
    create: vi.fn(() => editor),
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
  };

  return {
    module: { editor: editorApi },
    editor,
    editorApi,
    changeDisposable,
    sizeDisposable,
    invokeChange: () => changeListener?.(),
    invokeSizeChange: () => sizeListener?.(),
  };
});

vi.mock('monaco-editor', () => monacoMocks.module);

describe('MonacoEditorCore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monacoMocks.editor.getValue.mockReturnValue('initial value');
    monacoMocks.editor.getContentHeight.mockReturnValue(72);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates Monaco with consumer options and forwards lifecycle and change callbacks', async () => {
    const beforeMount = vi.fn();
    const onMount = vi.fn();
    const onChange = vi.fn();
    const { unmount } = render(
      <MonacoEditorCore
        value="initial value"
        language="typescript"
        theme="custom-theme"
        options={{ readOnly: true, lineNumbers: 'off' }}
        beforeMount={beforeMount}
        onMount={onMount}
        onChange={onChange}
      />,
    );

    await waitFor(() => expect(monacoMocks.editorApi.create).toHaveBeenCalledOnce());
    expect(monacoMocks.editorApi.defineTheme).toHaveBeenCalledTimes(2);
    expect(beforeMount).toHaveBeenCalledWith(monacoMocks.module);
    expect(monacoMocks.editorApi.create).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        value: 'initial value',
        language: 'typescript',
        theme: 'custom-theme',
        readOnly: true,
        lineNumbers: 'off',
      }),
    );
    expect(onMount).toHaveBeenCalledWith(monacoMocks.editor, monacoMocks.module);

    monacoMocks.editor.getValue.mockReturnValue('edited value');
    act(() => monacoMocks.invokeChange());
    expect(onChange).toHaveBeenCalledWith('edited value');

    unmount();
    expect(monacoMocks.changeDisposable.dispose).toHaveBeenCalledOnce();
    expect(monacoMocks.editor.dispose).toHaveBeenCalledOnce();
  });

  it('syncs external values without recreating the editor', async () => {
    const { rerender } = render(<MonacoEditorCore value="first" />);
    await waitFor(() => expect(monacoMocks.editorApi.create).toHaveBeenCalledOnce());

    monacoMocks.editor.getValue.mockReturnValue('first');
    rerender(<MonacoEditorCore value="second" />);

    await waitFor(() => expect(monacoMocks.editor.setValue).toHaveBeenCalledWith('second'));
    expect(monacoMocks.editorApi.create).toHaveBeenCalledOnce();
  });

  it('clamps auto-height and responds to Monaco content-size changes', async () => {
    monacoMocks.editor.getContentHeight.mockReturnValue(500);
    const onAutoHeightChange = vi.fn();
    const { container, unmount } = render(
      <MonacoEditorCore
        value={'one\ntwo'}
        autoHeight
        minHeight={30}
        maxHeight={100}
        onAutoHeightChange={onAutoHeightChange}
      />,
    );

    await waitFor(() => expect(monacoMocks.editorApi.create).toHaveBeenCalledOnce());
    const editorContainer = container.querySelector('.aui-monaco');
    expect(editorContainer).toHaveStyle({ height: '100px' });
    expect(monacoMocks.editor.layout).toHaveBeenCalled();
    expect(onAutoHeightChange).toHaveBeenLastCalledWith(100);

    monacoMocks.editor.getContentHeight.mockReturnValue(10);
    act(() => monacoMocks.invokeSizeChange());
    expect(editorContainer).toHaveStyle({ height: '30px' });
    expect(onAutoHeightChange).toHaveBeenLastCalledWith(30);

    unmount();
    expect(monacoMocks.sizeDisposable.dispose).toHaveBeenCalledOnce();
  });

  it('creates the editor with the latest value when it changed while Monaco was loading', async () => {
    const { rerender } = render(<MonacoEditorCore value="first" />);
    rerender(<MonacoEditorCore value="second" />);

    await waitFor(() => expect(monacoMocks.editorApi.create).toHaveBeenCalledOnce());
    expect(monacoMocks.editorApi.create).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ value: 'second' }),
    );
  });

  it('creates the editor with the latest theme when the mode changed while Monaco was loading', async () => {
    const { rerender } = render(
      <ThemeProvider theme={{ mode: 'light' }}>
        <MonacoEditorCore value="x" />
      </ThemeProvider>,
    );
    rerender(
      <ThemeProvider theme={{ mode: 'dark' }}>
        <MonacoEditorCore value="x" />
      </ThemeProvider>,
    );

    await waitFor(() => expect(monacoMocks.editorApi.create).toHaveBeenCalledOnce());
    expect(monacoMocks.editorApi.create).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ theme: 'aui-monaco-dark' }),
    );
  });

  it('builds the editor theme from the app text and gutter tokens and redefines it on a mode change', async () => {
    // jsdom does not inherit custom properties, so serve the theme tokens straight from the style lookup.
    let tokens: Record<string, string> = {
      '--text-primary': '#2c2a26',
      '--text-secondary': '#746b5d',
      '--border': 'not-a-color',
    };
    vi.spyOn(CSSStyleDeclaration.prototype, 'getPropertyValue').mockImplementation(name => tokens[name] ?? '');

    function Editor({ mode }: { mode: 'light' | 'dark' }) {
      return (
        <ThemeProvider theme={{ mode }}>
          <MonacoEditorCore value="x" />
        </ThemeProvider>
      );
    }

    const { rerender } = render(<Editor mode="light" />);
    await waitFor(() => expect(monacoMocks.editorApi.create).toHaveBeenCalledOnce());

    const lightCall = monacoMocks.editorApi.defineTheme.mock.calls.find(([name]) => name === 'aui-monaco-light');
    expect(lightCall?.[1].colors).toMatchObject({
      'editor.foreground': '#2c2a26',
      'editorLineNumber.foreground': '#746b5d',
    });
    expect(lightCall?.[1].colors).not.toHaveProperty('editorIndentGuide.background1');

    monacoMocks.editorApi.defineTheme.mockClear();
    tokens = { ...tokens, '--text-primary': '#f2ecdd' };
    rerender(<Editor mode="dark" />);

    await waitFor(() => expect(monacoMocks.editorApi.setTheme).toHaveBeenCalledWith('aui-monaco-dark'));
    const darkCall = monacoMocks.editorApi.defineTheme.mock.calls.find(([name]) => name === 'aui-monaco-dark');
    expect(darkCall?.[1]).toMatchObject({ base: 'vs-dark', colors: { 'editor.foreground': '#f2ecdd' } });
  });
});
