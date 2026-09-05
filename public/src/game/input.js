/**
 * Input.
 *
 * One place binds listeners, one place removes them. attach()/detach() are
 * idempotent, which is what stops listeners piling up over a few hundred
 * sessions at a stall.
 *
 * Flap sources: pointer down on the play surface, Space / Arrow Up / Enter,
 * and touch. Buttons in the UI call their own handlers and are deliberately
 * excluded from the play surface so a tap on "Next attempt" is never also a flap.
 */

export class InputManager {
  constructor(surface, { onFlap, onAnyInput } = {}) {
    this.surface = surface;
    this.onFlap = onFlap || (() => {});
    this.onAnyInput = onAnyInput || (() => {});
    this.attached = false;

    this.handlePointerDown = (event) => {
      if (event.button != null && event.button !== 0) return;
      // Any press counts as "somebody is still here", even a press on a button.
      this.onAnyInput();
      // Presses that land on interactive UI drawn above the canvas never flap.
      if (event.target && event.target.closest && event.target.closest('[data-no-flap]')) return;
      event.preventDefault();
      this.onFlap();
    };

    this.handleKeyDown = (event) => {
      if (event.repeat) return;
      this.onAnyInput();
      const key = event.key;
      if (key !== ' ' && key !== 'Spacebar' && key !== 'ArrowUp' && key !== 'Enter') return;
      const target = event.target;
      // Never steal Space/Enter from the name field or a focused button.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON')) {
        return;
      }
      event.preventDefault();
      this.onFlap();
    };

    this.handleContextMenu = (event) => event.preventDefault();
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    this.surface.addEventListener('pointerdown', this.handlePointerDown, { passive: false });
    this.surface.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('keydown', this.handleKeyDown, { passive: false });
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.surface.removeEventListener('pointerdown', this.handlePointerDown);
    this.surface.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('keydown', this.handleKeyDown);
  }
}
