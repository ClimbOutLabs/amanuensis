import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HELP_AREA_IDS } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

import { AmanTour, greetingFor, pickHelpArea } from '@/components/AmanTour.js';
import {
  HELP_AREAS,
  MORNING_BRIEF,
  WAITING_PROMPT,
  WATCHING_PROMPT,
  type TourCapabilities,
} from '@/components/tourPrompts.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };
const NONE: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };
const MORNING = new Date(2026, 9, 21, 9, 0);

function renderTour(overrides: Partial<ComponentProps<typeof AmanTour>> = {}) {
  const props: ComponentProps<typeof AmanTour> = {
    capabilities: NONE,
    helpAreas: [],
    onHelpAreasChange: vi.fn(),
    now: MORNING,
    waiting: { count: 0, firstId: null },
    scheduleCount: 0,
    canSend: true,
    onSend: vi.fn(),
    onHide: vi.fn(),
    setup: null,
    ...overrides,
  };
  const { container } = render(<AmanTour {...props} />);
  return { props, container };
}

describe('AmanTour day ticket', () => {
  it('greets the person by name and says what Aman is', () => {
    renderTour({ userName: ' Sam ' });

    expect(screen.getByRole('heading', { level: 1, name: 'Good morning, Sam.' })).toBeInTheDocument();
    expect(screen.getByText('Aman is your chief of staff')).toBeInTheDocument();
  });

  it('greets without a name when none is set', () => {
    renderTour({ userName: null });

    expect(screen.getByRole('heading', { level: 1, name: 'Good morning.' })).toBeInTheDocument();
  });

  it('reads the stub as the day, what runs on a schedule, and what is waiting', () => {
    renderTour({ waiting: { count: 2, firstId: 'a1' }, scheduleCount: 1 });
    const stub = within(screen.getByRole('region', { name: 'Your day' }));

    expect(stub.getByText('Wed 21 Oct')).toBeInTheDocument();
    expect(stub.getByText('1 thing runs on a schedule')).toBeInTheDocument();
    expect(stub.getByText('2 things need you')).toBeInTheDocument();
  });

  it('says nothing runs on a schedule when the count is zero, and shows "Nothing needs you" once', () => {
    renderTour();
    const stub = within(screen.getByRole('region', { name: 'Your day' }));

    expect(stub.getByText('Nothing runs on a schedule yet')).toBeInTheDocument();
    expect(stub.queryByText('Nothing needs you')).not.toBeInTheDocument();
    expect(screen.getAllByText('Nothing needs you')).toHaveLength(1);
  });

  it('sweeps the waiting count with the highlight piece, and draws no sweep when nothing waits', () => {
    const { container } = renderTour({ waiting: { count: 1, firstId: 'a1' } });
    expect(container.querySelector('.aui-reward-highlight')).toHaveTextContent('1 thing needs you');
  });

  it('draws no sweep when nothing waits', () => {
    const { container } = renderTour();
    expect(container.querySelector('.aui-reward-highlight')).toBeNull();
  });
});

describe('AmanTour gold fill', () => {
  it('fills only the needs-you ticket, and only when an approval is waiting', () => {
    const { container } = renderTour({ waiting: { count: 1, firstId: 'a1' } });
    const selected = container.querySelectorAll('.aui-ticket--selected');

    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('1 thing needs you');
  });

  it('fills no card when nothing waits on the person', () => {
    const { container } = renderTour();

    expect(container.querySelectorAll('.aui-ticket--selected')).toHaveLength(0);
  });
});

describe('AmanTour tickets', () => {
  it('makes each of the three tickets a button whose prompt, or the brief in plain words, is its description', () => {
    renderTour({ waiting: { count: 1, firstId: 'a1' } });

    expect(screen.getByRole('button', { name: /Your brief is ready/ })).toHaveAccessibleDescription(
      'Asks for your morning brief: what to check first, decisions waiting on you, what is coming up, and what is due.',
    );
    expect(screen.getByRole('button', { name: /1 thing needs you/ })).toHaveAccessibleDescription(
      WAITING_PROMPT.prompt,
    );
    expect(screen.getByRole('button', { name: /Quietly watching/ })).toHaveAccessibleDescription(
      WATCHING_PROMPT.prompt,
    );
  });

  it('sends the exact prompt of each ticket', () => {
    const { props } = renderTour();

    fireEvent.click(screen.getByRole('button', { name: /Your brief is ready/ }));
    fireEvent.click(screen.getByRole('button', { name: /Nothing needs you/ }));
    fireEvent.click(screen.getByRole('button', { name: /Quietly watching/ }));

    expect(props.onSend).toHaveBeenNthCalledWith(1, MORNING_BRIEF.prompt);
    expect(props.onSend).toHaveBeenNthCalledWith(2, WAITING_PROMPT.prompt);
    expect(props.onSend).toHaveBeenNthCalledWith(3, WATCHING_PROMPT.prompt);
  });

  it('shows the setup line under Quietly watching when the host passes one', () => {
    renderTour({ setup: <p>2 of 3 set up →</p> });

    const watching = screen.getByRole('button', { name: /Quietly watching/ }).closest('li');
    expect(watching).toHaveTextContent('2 of 3 set up →');
  });

  it('turns every button off and says why when no model is set', () => {
    const { props } = renderTour({ canSend: false });

    const brief = screen.getByRole('button', { name: /Your brief is ready/ });
    expect(brief).toBeDisabled();
    fireEvent.click(brief);
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a model in Settings before you start a chat.')).toBeInTheDocument();
  });
});

describe('AmanTour chooser', () => {
  function renderChooser(initial: ComponentProps<typeof AmanTour>['helpAreas'] = []) {
    const onHelpAreasChange = vi.fn();
    function Controlled() {
      const [areas, setAreas] = useState(initial);
      return (
        <AmanTour
          capabilities={NONE}
          helpAreas={areas}
          onHelpAreasChange={next => {
            onHelpAreasChange(next);
            setAreas(next);
          }}
          waiting={{ count: 0, firstId: null }}
          scheduleCount={0}
          canSend
          onSend={vi.fn()}
          onHide={vi.fn()}
          setup={null}
        />
      );
    }
    render(<Controlled />);
    return { onHelpAreasChange };
  }

  it('lets one area be chosen at a time: picking a second clears the first, and picking it again clears it', () => {
    const { onHelpAreasChange } = renderChooser();
    const focus = screen.getByRole('radio', { name: 'Focus and getting started' });
    const family = screen.getByRole('radio', { name: 'Family and home' });

    fireEvent.click(focus);
    expect(focus).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(family);
    expect(focus).toHaveAttribute('aria-checked', 'false');
    expect(family).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('radio', { checked: true })).toHaveLength(1);

    fireEvent.click(family);
    expect(family).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryAllByRole('radio', { checked: true })).toHaveLength(0);
    expect(onHelpAreasChange).toHaveBeenLastCalledWith([]);
  });

  it('is a radio group named by its question', () => {
    renderChooser();

    const group = screen.getByRole('radiogroup', { name: 'What would help you most?' });
    expect(within(group).getAllByRole('radio')).toHaveLength(HELP_AREA_IDS.length);
  });

  it('moves between pills with the arrow keys, choosing each one, and wraps around', () => {
    renderChooser(['focus']);
    const focus = screen.getByRole('radio', { name: 'Focus and getting started' });
    const family = screen.getByRole('radio', { name: 'Family and home' });
    const last = screen.getByRole('radio', { name: HELP_AREAS.work_money.label });

    expect(focus).toHaveAttribute('tabindex', '0');
    expect(family).toHaveAttribute('tabindex', '-1');

    act(() => focus.focus());
    fireEvent.keyDown(focus, { key: 'ArrowRight' });
    expect(family).toHaveFocus();
    expect(family).toHaveAttribute('aria-checked', 'true');
    expect(focus).toHaveAttribute('aria-checked', 'false');

    fireEvent.keyDown(family, { key: 'ArrowLeft' });
    expect(focus).toHaveFocus();
    expect(focus).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(focus, { key: 'ArrowUp' });
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps one pill in the tab order: the chosen one, or the first when none is chosen', () => {
    renderChooser();
    expect(screen.getByRole('radio', { name: 'Focus and getting started' })).toHaveAttribute('tabindex', '0');

    fireEvent.click(screen.getByRole('radio', { name: 'Caring for someone' }));
    expect(screen.getByRole('radio', { name: 'Caring for someone' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Focus and getting started' })).toHaveAttribute('tabindex', '-1');
  });

  it('keeps only the first saved area as the chosen pill when the saved list holds more', () => {
    renderChooser(['family', 'focus']);

    expect(screen.getByRole('radio', { name: 'Family and home' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Focus and getting started' })).toHaveAttribute('aria-checked', 'false');
  });

  it('labels the pills with the shared label class and no monospace', () => {
    const { container } = renderTour();

    expect(screen.getByRole('heading', { name: 'What would help you most?' })).toHaveClass('aui-tour-label');
    expect(screen.getByText('Aman is your chief of staff')).toHaveClass('aui-tour-label');
    expect(container.querySelector('.font-mono')).toBeNull();
  });
});

describe('pickHelpArea', () => {
  it('replaces the chosen area with the new one', () => {
    expect(pickHelpArea({ current: ['focus'], id: 'family' })).toEqual(['family']);
  });

  it('clears the choice when the chosen area is picked again', () => {
    expect(pickHelpArea({ current: ['family'], id: 'family' })).toEqual([]);
  });
});

describe('AmanTour capability tickets by area', () => {
  it('shapes the four capability tickets by the chosen areas', () => {
    renderTour({ capabilities: ALL, helpAreas: ['focus'] });

    expect(screen.getByRole('button', { name: 'Help me clear my head' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Help me break a task into steps' })).toBeInTheDocument();
  });
});

describe('AmanTour capability tickets', () => {
  it('shows four tickets, each sending its exact prompt', () => {
    const { props } = renderTour({ capabilities: NONE });
    const list = within(screen.getByRole('region', { name: 'What Aman can do' }));

    expect(list.getAllByRole('button')).toHaveLength(4);
    fireEvent.click(list.getByRole('button', { name: 'Get to know Aman' }));
    expect(props.onSend).toHaveBeenCalledWith(expect.stringMatching(/^Iris, /));
  });

  it('draws a picture on a ticket that has one and keeps the label as the name', () => {
    const { container } = renderTour({ capabilities: NONE });
    const schedule = screen.getByRole('button', { name: 'Run things on a schedule' });

    expect(schedule.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    expect(container.querySelectorAll('.aui-ticket--selected')).toHaveLength(0);
  });
});

describe('AmanTour phone panda', () => {
  it('shows the round panda ticket with the picture and its alt text when the host gives a picture', () => {
    renderTour({ pandaSrc: '/aman-avatar.png' });

    const picture = screen.getByAltText('Aman, drawn as a panda writing with a quill');
    expect(picture).toHaveAttribute('src', '/aman-avatar.png');
    expect(picture.closest('.sm\\:hidden')).not.toBeNull();
  });

  it('leaves the panda out when the host gives no picture', () => {
    renderTour({ pandaSrc: null });

    expect(screen.queryByAltText('Aman, drawn as a panda writing with a quill')).not.toBeInTheDocument();
  });
});

describe('AmanTour wording', () => {
  it('shows no tool names, identifiers or raw JSON to the person', () => {
    const { container } = renderTour({ capabilities: ALL, waiting: { count: 3, firstId: 'a1' }, scheduleCount: 2 });

    expect(container.textContent).not.toMatch(/tool|[{}]|_id|approval_/i);
  });

  it('hands the hide control to the host', () => {
    const { props } = renderTour();

    fireEvent.click(screen.getByRole('button', { name: 'Hide the tour' }));
    expect(props.onHide).toHaveBeenCalledTimes(1);
  });
});

describe('greetingFor', () => {
  it('greets by the local hour', () => {
    expect(greetingFor(new Date(2026, 9, 21, 8, 0))).toBe('Good morning');
    expect(greetingFor(new Date(2026, 9, 21, 13, 0))).toBe('Good afternoon');
    expect(greetingFor(new Date(2026, 9, 21, 20, 0))).toBe('Good evening');
  });
});

describe('AmanTour assistant name', () => {
  it('uses the chosen name on every line of the first frame and never says Aman', () => {
    const { container } = renderTour({
      assistantName: 'Maya',
      userName: 'Sam',
      capabilities: ALL,
      waiting: { count: 1, firstId: 'a1' },
      scheduleCount: 1,
      setup: <p>2 of 3 set up →</p>,
      pandaSrc: '/aman-avatar.png',
    });

    expect(container.textContent).toContain('Maya is your chief of staff');
    expect(screen.getByRole('heading', { name: 'What Maya can do' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Get to know Maya/ })).toBeInTheDocument();
    expect(screen.getByText('Maya', { selector: '.aui-tour-title' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Aman/);
  });

  it('falls back to Aman when the person has not chosen a name', () => {
    renderTour({ assistantName: null, capabilities: ALL });

    expect(screen.getByRole('button', { name: /Get to know Aman/ })).toBeInTheDocument();
    expect(screen.getByText('Aman is your chief of staff')).toBeInTheDocument();
  });
});
