'use client';

import { createLibrary, useStateField } from '@openuidev/react-lang';
import {
  Callout as OpenUiCallout,
  Steps as OpenUiSteps,
  StepsItem as OpenUiStepsItem,
  openuiLibrary,
} from '@openuidev/react-ui';
import { useEffect, type CSSProperties, type ReactNode } from 'react';

import { useSlot } from '../../theme/SlotsProvider.js';
import { MarkdownImage } from '../Markdown.js';
import { cn } from './cn.js';

type OpenUiRenderer = (typeof openuiLibrary.components)[string]['component'];

/** What a library renderer receives: the evaluated props and the child renderer. */
type GatedRenderProps = {
  props: Record<string, unknown>;
  renderNode: (value: unknown) => ReactNode;
  statementId?: string;
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A plain record copy of an object value, or null for anything else. */
function recordValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry;
  }
  return out;
}

/** Child statements of a component (Steps items), as their evaluated props. */
function nodePropsList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    out.push(recordValue(Reflect.get(item, 'props')) ?? {});
  }
  return out;
}

/**
 * Markdown written inside a fence, rendered by the chat Markdown component itself, so
 * its images and links take the chat image and link gates instead of loading directly.
 */
function GatedMarkdownText({ text, spacePictures }: { text: string; spacePictures: boolean }) {
  const Markdown = useSlot('Markdown');
  return <Markdown content={text} spacePictures={spacePictures} />;
}

const TEXT_BODY_SIZE_VARS: Record<string, string> = {
  small: '--openui-text-body-sm',
  default: '--openui-text-body-default',
  large: '--openui-text-body-lg',
  'small-heavy': '--openui-text-body-sm-heavy',
  'large-heavy': '--openui-text-body-lg-heavy',
};

type TextContentStyle = CSSProperties & {
  '--openui-text-body-default': string;
  '--openui-text-body-default-letter-spacing': string;
};

const CALLOUT_VARIANTS: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = {
  info: 'info',
  warning: 'warning',
  success: 'success',
  error: 'warning',
  neutral: 'neutral',
};

/**
 * A copy of the pinned OpenUI library whose image and markdown components render
 * through Aman's chat gates. The pinned components load a remote image address the
 * moment they render and render nested markdown with direct links; these replacements
 * keep the same names, prop shapes and descriptions, so a fence can express exactly
 * what it could before, and only how its images and links load changes. No `onAction`
 * handler is involved: fence actions stay inert, as they are today. ListBlock and
 * ListItem are not in the library Aman ships (they exist only in the package's chat
 * library, and the fence parser rejects them), so no fence can reach their images.
 */
export function createGatedOpenUiLibrary({
  spacePictures,
}: {
  spacePictures: boolean;
}): ReturnType<typeof createLibrary> {
  const gatedImage = ({ props }: GatedRenderProps): ReactNode => {
    const src = stringValue(props.src);
    if (src.trim() === '') {
      return null;
    }
    return <MarkdownImage src={src} alt={stringValue(props.alt)} imgProps={{}} spacePictures={spacePictures} />;
  };

  function GatedCalloutRenderer({ props }: GatedRenderProps): ReactNode {
    const field = useStateField('visible', props.visible);
    const hasVisibleBinding = field.isReactive;
    const isVisible = hasVisibleBinding ? field.value === true || field.value === 'true' : true;

    // A bound callout dismisses itself after 3 seconds, as the pinned one does.
    useEffect(() => {
      if (!hasVisibleBinding || !isVisible) {
        return;
      }
      const timer = setTimeout(() => {
        field.setValue(false);
      }, 3000);
      return () => clearTimeout(timer);
    }, [hasVisibleBinding, isVisible, field]);

    if (!isVisible) {
      return null;
    }
    return (
      <OpenUiCallout
        variant={CALLOUT_VARIANTS[stringValue(props.variant)] ?? 'info'}
        title={stringValue(props.title)}
        description={<GatedMarkdownText text={stringValue(props.description)} spacePictures={spacePictures} />}
        duration={hasVisibleBinding ? 3000 : undefined}
      />
    );
  }

  const renderers: Record<string, OpenUiRenderer> = {
    Image: gatedImage,
    ImageBlock: gatedImage,
    ImageGallery: ({ props }: GatedRenderProps): ReactNode => {
      const images = Array.isArray(props.images) ? props.images : [];
      const entries: Array<{ src: string; alt: string; details: string }> = [];
      images.forEach((entry, index) => {
        const record = recordValue(entry);
        if (record === null) {
          return;
        }
        const src = stringValue(record.src);
        if (src.trim() === '') {
          return;
        }
        const alt = stringValue(record.alt);
        entries.push({
          src,
          alt: alt === '' ? `Gallery image ${String(index + 1)}` : alt,
          details: stringValue(record.details),
        });
      });
      if (entries.length === 0) {
        return null;
      }
      return (
        <div className="flex flex-wrap gap-2">
          {entries.map((entry, index) => (
            <span key={index} className="flex flex-col gap-1">
              <MarkdownImage src={entry.src} alt={entry.alt} imgProps={{}} spacePictures={spacePictures} />
              {entry.details !== '' ? <span className="text-xs text-text-secondary">{entry.details}</span> : null}
            </span>
          ))}
        </div>
      );
    },
    MarkDownRenderer: ({ props }: GatedRenderProps): ReactNode => {
      const variant = stringValue(props.variant);
      return (
        <div
          className={cn(
            'openui-markdown-renderer',
            variant === 'card' && 'openui-markdown-renderer-card',
            variant === 'sunk' && 'openui-markdown-renderer-card-sunk',
          )}
        >
          <GatedMarkdownText text={stringValue(props.textMarkdown)} spacePictures={spacePictures} />
        </div>
      );
    },
    TextContent: ({ props }: GatedRenderProps): ReactNode => {
      const size = stringValue(props.size) === '' ? 'default' : stringValue(props.size);
      const varName = TEXT_BODY_SIZE_VARS[size] ?? TEXT_BODY_SIZE_VARS['default'];
      const style: TextContentStyle | undefined =
        size === 'default' || varName === undefined
          ? undefined
          : {
              '--openui-text-body-default': `var(${varName})`,
              '--openui-text-body-default-letter-spacing': `var(${varName}-letter-spacing)`,
            };
      const text = props.text === null || props.text === undefined ? '' : String(props.text);
      return (
        <div style={style}>
          <GatedMarkdownText text={text} spacePictures={spacePictures} />
        </div>
      );
    },
    Callout: GatedCalloutRenderer,
    Steps: ({ props, renderNode }: GatedRenderProps): ReactNode => {
      const items = nodePropsList(props.items);
      return (
        <OpenUiSteps>
          {items.map((item, index) => {
            const details = item.details;
            return (
              <OpenUiStepsItem
                key={index}
                number={index + 1}
                title={stringValue(item.title)}
                details={
                  typeof details === 'string' ? (
                    <GatedMarkdownText text={details} spacePictures={spacePictures} />
                  ) : (
                    renderNode(details)
                  )
                }
              />
            );
          })}
        </OpenUiSteps>
      );
    },
  };

  const components = Object.values(openuiLibrary.components).map(definition => {
    const replacement = renderers[definition.name];
    return replacement === undefined ? definition : { ...definition, component: replacement };
  });

  return createLibrary({
    root: openuiLibrary.root,
    componentGroups: openuiLibrary.componentGroups,
    components,
  });
}
