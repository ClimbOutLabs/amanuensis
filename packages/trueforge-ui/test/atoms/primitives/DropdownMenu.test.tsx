import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/atoms/primitives/DropdownMenu.js';

describe('DropdownMenu', () => {
  it('opens and closes from clicks, menu selection, and outside interaction', () => {
    const onTriggerClick = vi.fn();
    const onSelect = vi.fn();

    render(
      <div>
        <DropdownMenu trigger={<button onClick={onTriggerClick}>Actions</button>} className="host-menu">
          <DropdownMenuItem onClick={onSelect}>Rename</DropdownMenuItem>
        </DropdownMenu>
        <button>Outside</button>
      </div>,
    );

    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');

    fireEvent.click(trigger);

    const menu = screen.getByRole('menu');
    expect(onTriggerClick).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(menu).toHaveClass('host-menu');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('merges trigger keyboard handling and manages focus across enabled items', () => {
    const onTriggerKeyDown = vi.fn();
    const onDisabledClick = vi.fn();

    render(
      <DropdownMenu
        trigger={
          <button data-host-trigger="true" onKeyDown={onTriggerKeyDown}>
            Actions
          </button>
        }
      >
        <DropdownMenuItem data-item-id="first">First</DropdownMenuItem>
        <DropdownMenuItem disabled onClick={onDisabledClick}>
          Disabled
        </DropdownMenuItem>
        <DropdownMenuItem data-item-id="last">Last</DropdownMenuItem>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger).toHaveAttribute('data-host-trigger', 'true');

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onTriggerKeyDown).toHaveBeenCalledOnce();
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

    const disabled = screen.getByRole('menuitem', { name: 'Disabled' });
    expect(disabled).toBeDisabled();

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disabled' }));
    expect(onDisabledClick).not.toHaveBeenCalled();
  });

  it('forwards item and separator host attributes', () => {
    render(
      <DropdownMenu trigger={<button>Actions</button>}>
        <DropdownMenuItem name="rename" aria-label="Rename item">
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator data-divider="actions" aria-label="More actions" />
      </DropdownMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menuitem', { name: 'Rename item' })).toHaveAttribute('name', 'rename');
    expect(screen.getByRole('separator', { name: 'More actions' })).toHaveAttribute('data-divider', 'actions');
  });

  it('portals the menu outside an overflow-hidden ancestor', () => {
    render(
      <div data-testid="clipped" style={{ overflow: 'hidden', height: 24 }}>
        <DropdownMenu trigger={<button>Actions</button>}>
          <DropdownMenuItem>Edit</DropdownMenuItem>
          <DropdownMenuItem>Resume</DropdownMenuItem>
          <DropdownMenuItem>Delete</DropdownMenuItem>
        </DropdownMenu>
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));

    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId('clipped').contains(menu)).toBe(false);
    expect(menu.className).toContain('fixed');
  });

  it('keeps the menu open for interactive content when closeOnClick is false', () => {
    render(
      <DropdownMenu closeOnClick={false} trigger={<button>Actions</button>}>
        <button type="button">Interactive content</button>
      </DropdownMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Interactive content' }));

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('keeps a parent menu open while selecting from a nested portaled menu', () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu closeOnClick={false} trigger={<button>Settings</button>}>
        <DropdownMenu trigger={<button>Type</button>}>
          <DropdownMenuItem onClick={onSelect}>JSON</DropdownMenuItem>
        </DropdownMenu>
      </DropdownMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));

    const nestedItem = screen.getByRole('menuitem', { name: 'JSON' });
    fireEvent.mouseDown(nestedItem);
    fireEvent.click(nestedItem);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('supports controlled open state', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <DropdownMenu open={false} onOpenChange={onOpenChange} trigger={<button>Actions</button>}>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    rerender(
      <DropdownMenu open onOpenChange={onOpenChange} trigger={<button>Actions</button>}>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenu>,
    );
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('calls the latest onOpenChange when an outside mousedown closes the menu', () => {
    const firstOnOpenChange = vi.fn();
    const secondOnOpenChange = vi.fn();
    const { rerender } = render(
      <DropdownMenu trigger={<button>Actions</button>} onOpenChange={firstOnOpenChange}>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(firstOnOpenChange).toHaveBeenCalledWith(true);
    firstOnOpenChange.mockClear();

    rerender(
      <DropdownMenu trigger={<button>Actions</button>} onOpenChange={secondOnOpenChange}>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenu>,
    );

    fireEvent.mouseDown(document.body);

    expect(firstOnOpenChange).not.toHaveBeenCalled();
    expect(secondOnOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('calls the latest onOpenChange when Escape closes the menu', () => {
    const firstOnOpenChange = vi.fn();
    const secondOnOpenChange = vi.fn();
    const { rerender } = render(
      <DropdownMenu trigger={<button>Actions</button>} onOpenChange={firstOnOpenChange}>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(firstOnOpenChange).toHaveBeenCalledWith(true);
    firstOnOpenChange.mockClear();

    rerender(
      <DropdownMenu trigger={<button>Actions</button>} onOpenChange={secondOnOpenChange}>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenu>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(firstOnOpenChange).not.toHaveBeenCalled();
    expect(secondOnOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('DropdownMenu dismissal', () => {
  function renderMenu(extra?: ReactNode) {
    return render(
      <DropdownMenu trigger={<button type="button">More</button>}>
        <button type="button" role="menuitem">
          Rename
        </button>
        <p>Menu note</p>
        {extra}
      </DropdownMenu>,
    );
  }

  it('closes on an outside click and on Escape, and returns focus to the trigger on Escape', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
  });

  it('stays open for a click inside its panel that is not an item', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    fireEvent.mouseDown(screen.getByText('Menu note'));
    fireEvent.click(screen.getByText('Menu note'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes when a menu item is chosen', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the menu open while a dialog it opened is clicked, so the dialog can finish its action', () => {
    const dialog = (
      <div role="dialog" aria-label="Delete chat">
        <button type="button">Confirm delete</button>
      </div>
    );
    renderMenu(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
