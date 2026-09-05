/**
 * Screen controller - every DOM read/write lives here.
 *
 * Gameplay and session code never touch elements; they hand this module a
 * snapshot and it decides what the stall sees. DOM work is kept off the hot
 * path: the HUD only writes when a value actually changed, and screens only
 * re-render on a state change.
 */

import { RULES } from '../config.js';
import { STATE } from '../session/sessionMachine.js';
import { ROSTER, getVariant } from '../assets/manifest.js';

const BUTTON_LOCK_MS = 450;

export class ScreenController {
  constructor(handlers = {}) {
    this.handlers = handlers;

    this.el = {
      stage: document.getElementById('stage'),
      hudScore: document.getElementById('hudScore'),
      hudAttemptLabel: document.getElementById('hudAttemptLabel'),
      hudPips: document.getElementById('hudPips'),

      attractTagline: document.getElementById('attractTagline'),
      nameForm: document.getElementById('nameForm'),
      playerName: document.getElementById('playerName'),
      startButton: document.getElementById('startButton'),
      miniBoardList: document.getElementById('miniBoardList'),

      selectPlayer: document.getElementById('selectPlayer'),
      selectPips: document.getElementById('selectPips'),
      roster: document.getElementById('roster'),

      readyPlayer: document.getElementById('readyPlayer'),
      readyAttempt: document.getElementById('readyAttempt'),
      readyPips: document.getElementById('readyPips'),

      overBanner: document.getElementById('overBanner'),
      overScore: document.getElementById('overScore'),
      overBest: document.getElementById('overBest'),
      overRemaining: document.getElementById('overRemaining'),
      overPips: document.getElementById('overPips'),
      continueButton: document.getElementById('continueButton'),
      abandonButton: document.getElementById('abandonButton'),

      submittingScore: document.getElementById('submittingScore'),

      rankBadge: document.getElementById('rankBadge'),
      rankValue: document.getElementById('rankValue'),
      rankCaption: document.getElementById('rankCaption'),
      resultBest: document.getElementById('resultBest'),
      attemptStrip: document.getElementById('attemptStrip'),
      boardStatus: document.getElementById('boardStatus'),
      boardList: document.getElementById('boardList'),
      newPlayerButton: document.getElementById('newPlayerButton'),

      soundToggle: document.getElementById('soundToggle'),
      soundIcon: document.getElementById('soundIcon'),
      toast: document.getElementById('toast')
    };

    this.lastHudScore = null;
    this.lastPipsKey = '';
    this.toastTimer = 0;
    this.locks = new WeakMap();

    this.buildRoster();
    this.buildPips(this.el.selectPips);
    this.buildPips(this.el.hudPips);
    this.buildPips(this.el.readyPips);
    this.buildPips(this.el.overPips);
    this.bind();
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  bind() {
    this.onSubmitName = (event) => {
      event.preventDefault();
      if (this.isLocked(this.el.startButton)) return;
      this.lock(this.el.startButton);
      const name = this.el.playerName.value;
      this.el.playerName.blur();
      this.call('onStart', name);
    };

    this.onContinue = () => {
      if (this.isLocked(this.el.continueButton)) return;
      this.lock(this.el.continueButton);
      this.call('onContinue');
    };

    this.onAbandon = () => {
      if (this.isLocked(this.el.abandonButton)) return;
      this.lock(this.el.abandonButton);
      this.call('onAbandon');
    };

    this.onNewPlayer = () => {
      if (this.isLocked(this.el.newPlayerButton)) return;
      this.lock(this.el.newPlayerButton);
      this.call('onNewPlayer');
    };

    this.onToggleSound = () => this.call('onToggleSound');

    this.el.nameForm.addEventListener('submit', this.onSubmitName);
    this.el.continueButton.addEventListener('click', this.onContinue);
    this.el.abandonButton.addEventListener('click', this.onAbandon);
    this.el.newPlayerButton.addEventListener('click', this.onNewPlayer);
    this.el.soundToggle.addEventListener('click', this.onToggleSound);
  }

  destroy() {
    this.el.nameForm.removeEventListener('submit', this.onSubmitName);
    this.el.continueButton.removeEventListener('click', this.onContinue);
    this.el.abandonButton.removeEventListener('click', this.onAbandon);
    this.el.newPlayerButton.removeEventListener('click', this.onNewPlayer);
    this.el.soundToggle.removeEventListener('click', this.onToggleSound);
    if (this.el.roster && this.onRosterClick) {
      this.el.roster.removeEventListener('click', this.onRosterClick);
    }
    clearTimeout(this.rosterLock);
    clearTimeout(this.toastTimer);
  }

  call(name, ...args) {
    const handler = this.handlers[name];
    if (typeof handler === 'function') handler(...args);
  }

  /** Swallows the second half of a double click / double tap. */
  lock(button) {
    if (!button) return;
    button.disabled = true;
    const timer = setTimeout(() => {
      button.disabled = false;
      this.locks.delete(button);
    }, BUTTON_LOCK_MS);
    this.locks.set(button, timer);
  }

  isLocked(button) {
    return Boolean(button && button.disabled);
  }

  unlockAll() {
    for (const button of [
      this.el.startButton,
      this.el.continueButton,
      this.el.abandonButton,
      this.el.newPlayerButton
    ]) {
      const timer = this.locks.get(button);
      if (timer) clearTimeout(timer);
      this.locks.delete(button);
      button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* State rendering                                                     */
  /* ------------------------------------------------------------------ */

  render(snapshot) {
    this.el.stage.dataset.screen = snapshot.state;

    switch (snapshot.state) {
      case STATE.ATTRACT:
        this.renderAttract(snapshot);
        break;
      case STATE.SELECT:
        this.renderSelect(snapshot);
        break;
      case STATE.READY:
        this.renderReady(snapshot);
        break;
      case STATE.PLAYING:
        this.renderPlaying(snapshot);
        break;
      case STATE.ATTEMPT_OVER:
        this.renderAttemptOver(snapshot);
        break;
      case STATE.SUBMITTING:
        this.el.submittingScore.textContent = String(snapshot.bestScore);
        break;
      default:
        break;
    }
  }

  renderAttract() {
    this.unlockAll();
    this.lastHudScore = null;
    this.el.hudScore.textContent = '0';
    this.el.playerName.value = '';
  }

  /**
   * Builds the character cards once at startup. They never change during an
   * event, so this is not rebuilt per session - only the enabled state is.
   */
  buildRoster() {
    if (!this.el.roster) return;
    const fragment = document.createDocumentFragment();

    for (const id of ROSTER) {
      const variant = getVariant(id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'roster__card';
      card.dataset.character = id;

      const art = el('div', 'roster__art');
      if (variant.character && variant.character.src) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = variant.character.src;
        // No artwork installed yet: say so rather than showing a broken image.
        img.addEventListener('error', () => {
          art.replaceChildren(document.createTextNode('Art coming soon'));
          art.classList.add('roster__art--missing');
        });
        art.appendChild(img);
      }

      card.appendChild(art);
      card.appendChild(el('span', 'roster__name', variant.name || id));
      if (variant.tagline) card.appendChild(el('span', 'roster__tagline', variant.tagline));
      fragment.appendChild(card);
    }

    this.el.roster.replaceChildren(fragment);
    // Past four characters the cards need to give up their blurb to fit.
    this.el.roster.classList.toggle('roster--compact', ROSTER.length > 4);
    this.el.roster.classList.toggle('roster--wide', ROSTER.length > 6);

    // One listener on the container rather than one per card.
    this.onRosterClick = (event) => {
      const card = event.target.closest && event.target.closest('.roster__card');
      if (!card || card.disabled) return;
      this.lockRoster();
      this.call('onChooseCharacter', card.dataset.character);
    };
    this.el.roster.addEventListener('click', this.onRosterClick);
  }

  /** Stops a double tap picking twice while the character loads. */
  lockRoster() {
    for (const card of this.el.roster.children) card.disabled = true;
    clearTimeout(this.rosterLock);
    this.rosterLock = setTimeout(() => this.unlockRoster(), BUTTON_LOCK_MS);
  }

  unlockRoster() {
    clearTimeout(this.rosterLock);
    if (!this.el.roster) return;
    for (const card of this.el.roster.children) card.disabled = false;
  }

  renderSelect(snapshot) {
    this.unlockAll();
    this.unlockRoster();
    // The picker now shows before every attempt, so say which one is coming
    // and keep the running best in view.
    this.el.selectPlayer.textContent =
      snapshot.playerName +
      '  -  ATTEMPT ' + snapshot.attemptNumber + ' OF ' + RULES.attemptsPerSession +
      (snapshot.attemptsUsed > 0 ? '  -  BEST ' + snapshot.bestScore : '');
    this.setPips(this.el.selectPips, snapshot);
  }

  renderReady(snapshot) {
    this.unlockAll();
    this.el.readyPlayer.textContent =
      snapshot.playerName + '  as  ' + (getVariant(snapshot.characterId).name || '');
    this.el.readyAttempt.textContent =
      'ATTEMPT ' + snapshot.attemptNumber + ' OF ' + RULES.attemptsPerSession;
    this.setPips(this.el.readyPips, snapshot);
    this.setHudScore(0);
    this.setHudAttempt(snapshot);
  }

  renderPlaying(snapshot) {
    this.setHudScore(0);
    this.setHudAttempt(snapshot);
  }

  renderAttemptOver(snapshot) {
    this.unlockAll();

    const remaining = snapshot.attemptsRemaining;
    this.el.overBanner.textContent = 'ATTEMPT ' + snapshot.attemptsUsed + ' DONE';
    this.el.overScore.textContent = String(snapshot.lastScore);
    this.el.overBest.textContent = String(snapshot.bestScore);
    this.setPips(this.el.overPips, snapshot);

    if (remaining > 0) {
      this.el.overRemaining.textContent =
        remaining === 1 ? 'Last attempt coming up' : remaining + ' attempts left';
      this.el.continueButton.textContent = 'NEXT ATTEMPT (' + remaining + ' LEFT)';
      this.el.abandonButton.hidden = false;
    } else {
      this.el.overRemaining.textContent = 'All 3 attempts used';
      this.el.continueButton.textContent = 'SEE MY RANK';
      this.el.abandonButton.hidden = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                 */
  /* ------------------------------------------------------------------ */

  setHudScore(score, bump = false) {
    if (score === this.lastHudScore) return;
    this.lastHudScore = score;
    this.el.hudScore.textContent = String(score);
    if (!bump) return;

    // Restart the pop animation without a layout thrash loop.
    this.el.hudScore.classList.remove('is-bumped');
    void this.el.hudScore.offsetWidth;
    this.el.hudScore.classList.add('is-bumped');
  }

  setHudAttempt(snapshot) {
    const label = 'ATTEMPT ' + snapshot.attemptNumber + ' / ' + RULES.attemptsPerSession;
    if (this.el.hudAttemptLabel.textContent !== label) {
      this.el.hudAttemptLabel.textContent = label;
    }
    this.setPips(this.el.hudPips, snapshot);
  }

  buildPips(container) {
    if (!container) return;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < RULES.attemptsPerSession; i += 1) {
      const pip = document.createElement('span');
      pip.className = 'pip';
      pip.dataset.state = 'free';
      fragment.appendChild(pip);
    }
    container.replaceChildren(fragment);
  }

  setPips(container, snapshot) {
    if (!container) return;
    const current = snapshot.state === STATE.ATTEMPT_OVER ? -1 : snapshot.attemptsUsed;
    const key = container.id + ':' + snapshot.attemptsUsed + ':' + current;
    if (container.dataset.key === key) return;
    container.dataset.key = key;

    const pips = container.children;
    for (let i = 0; i < pips.length; i += 1) {
      pips[i].dataset.state = i < snapshot.attemptsUsed ? 'used' : i === current ? 'current' : 'free';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Leaderboards                                                        */
  /* ------------------------------------------------------------------ */

  renderMiniBoard(entries) {
    const list = this.el.miniBoardList;
    if (!entries || !entries.length) {
      list.replaceChildren(el('li', 'mini-board__empty', 'Be the first on the board!'));
      return;
    }

    // Four rows is what fits cleanly in the portrait attract panel; the full
    // board is shown on the result screen.
    const fragment = document.createDocumentFragment();
    for (const entry of entries.slice(0, 4)) {
      const row = el('li', 'mini-board__row');
      row.appendChild(el('span', '', String(entry.rank)));
      row.appendChild(el('span', '', entry.name));
      row.appendChild(el('span', '', String(entry.score)));
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
  }

  /**
   * The rewarding final screen: rank badge, best-of-three breakdown and the
   * board with the player's own row highlighted and scrolled into view.
   */
  renderResult(snapshot, result, displayLimit) {
    this.unlockAll();

    const rank = result && result.rank ? result.rank : null;
    this.el.rankValue.textContent = rank ? String(rank) : '-';
    this.el.rankBadge.dataset.podium = rank && rank <= 3 ? String(rank) : '';
    this.el.rankCaption.textContent = rank
      ? 'of ' + (result.total || rank) + ' players'
      : 'rank unavailable';
    this.el.resultBest.textContent = String(snapshot.bestScore);

    // Attempt breakdown - makes "best of three" self-explanatory.
    const bestIndex = snapshot.scores.indexOf(snapshot.bestScore);
    const strip = document.createDocumentFragment();
    snapshot.scores.forEach((score, index) => {
      const chip = el('div', 'attempt-chip');
      chip.dataset.best = String(index === bestIndex);
      chip.appendChild(el('span', 'attempt-chip__label', 'Try ' + (index + 1)));
      chip.appendChild(el('span', 'attempt-chip__value', String(score)));
      strip.appendChild(chip);
    });
    this.el.attemptStrip.replaceChildren(strip);

    if (result && result.pending) {
      this.el.boardStatus.hidden = false;
      this.el.boardStatus.textContent =
        'Saved on this device - the board will sync when the connection is back.';
    } else if (result && result.ok === false) {
      this.el.boardStatus.hidden = false;
      this.el.boardStatus.textContent = 'Showing the last known leaderboard.';
    } else {
      this.el.boardStatus.hidden = true;
    }

    this.renderBoard((result && result.entries) || [], snapshot.sessionId, displayLimit);
  }

  renderBoard(entries, sessionId, displayLimit) {
    const list = this.el.boardList;
    if (!entries.length) {
      list.replaceChildren(el('li', 'board__empty', 'No scores yet.'));
      return;
    }

    const limit = displayLimit || entries.length;
    const shown = entries.slice(0, limit);
    const playerIndex = entries.findIndex((entry) => entry.sessionId === sessionId);

    // If the player did not make the visible cut, append their row so they can
    // always see themselves.
    if (playerIndex >= limit) shown.push(entries[playerIndex]);

    const fragment = document.createDocumentFragment();
    let playerRow = null;

    for (const entry of shown) {
      const row = el('li', 'board__row');
      const isPlayer = Boolean(sessionId) && entry.sessionId === sessionId;
      if (isPlayer) row.dataset.you = 'true';
      if (entry.rank <= 3) row.dataset.podium = String(entry.rank);

      row.appendChild(el('span', 'board__rank', '#' + entry.rank));
      row.appendChild(el('span', 'board__name', entry.name));
      row.appendChild(el('span', 'board__score', String(entry.score)));
      fragment.appendChild(row);
      if (isPlayer) playerRow = row;
    }

    list.replaceChildren(fragment);
    if (playerRow) {
      // rAF so the browser has laid the list out before we scroll it.
      requestAnimationFrame(() => playerRow.scrollIntoView({ block: 'nearest' }));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bits and pieces                                                     */
  /* ------------------------------------------------------------------ */

  setTagline(text) {
    if (text) this.el.attractTagline.textContent = text;
  }

  setSoundLabel(muted) {
    this.el.soundIcon.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
  }

  focusName() {
    // Deliberately not autofocused on touch: a popped-up keyboard hides the
    // start button. Only grab focus where there is a physical keyboard.
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
      this.el.playerName.focus();
    }
  }

  toast(message, duration = 2600) {
    clearTimeout(this.toastTimer);
    this.el.toast.textContent = message;
    this.el.toast.hidden = false;
    this.toastTimer = setTimeout(() => {
      this.el.toast.hidden = true;
    }, duration);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
