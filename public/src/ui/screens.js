/**
 * Screen controller - every DOM read/write lives here.
 *
 * Gameplay and session code never touch elements; they hand this module a
 * snapshot and it decides what the stall sees. DOM work is kept off the hot
 * path: the HUD only writes when a value actually changed, and screens only
 * re-render on a state change.
 */

import { RULES, CHALLENGE } from '../config.js';
import { STATE } from '../session/sessionMachine.js';
import { ROSTER, getVariant } from '../assets/manifest.js';
import { STANDING, VERDICT } from '../challenge/challengeController.js';

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
      toast: document.getElementById('toast'),

      /* Challenge Mode */
      versusMeName: document.getElementById('versusMeName'),
      versusMeScore: document.getElementById('versusMeScore'),
      versusThemName: document.getElementById('versusThemName'),
      versusThemScore: document.getElementById('versusThemScore'),
      versusStanding: document.getElementById('versusStanding'),

      countdownBeat: document.getElementById('countdownBeat'),

      briefMeArt: document.getElementById('briefMeArt'),
      briefThemArt: document.getElementById('briefThemArt'),
      briefThemName: document.getElementById('briefThemName'),
      briefTarget: document.getElementById('briefTarget'),
      challengeForm: document.getElementById('challengeForm'),
      challengeName: document.getElementById('challengeName'),
      challengeError: document.getElementById('challengeError'),
      challengeStart: document.getElementById('challengeStart'),
      challengeCancel: document.getElementById('challengeCancel'),

      verdict: document.getElementById('verdict'),
      verdictSub: document.getElementById('verdictSub'),
      pbBadge: document.getElementById('pbBadge'),
      crMine: document.getElementById('crMine'),
      crTheirs: document.getElementById('crTheirs'),
      crThemLabel: document.getElementById('crThemLabel'),
      rematchButton: document.getElementById('rematchButton'),
      challengeExit: document.getElementById('challengeExit')
    };

    /* Cheap guard against writing the same HUD strings 120 times a second. */
    this.lastVersus = { mine: -1, theirs: -1, state: '' };

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

    this.onChallengeSubmit = (event) => {
      event.preventDefault();
      if (this.isLocked(this.el.challengeStart)) return;
      const name = this.el.challengeName.value;
      this.el.challengeName.blur();
      this.call('onChallengeStart', name);
    };

    this.onChallengeCancel = () => this.call('onChallengeCancel');
    this.onRematch = () => {
      if (this.isLocked(this.el.rematchButton)) return;
      this.lock(this.el.rematchButton);
      this.call('onRematch');
    };
    this.onChallengeExit = () => this.call('onChallengeExit');

    this.el.challengeForm.addEventListener('submit', this.onChallengeSubmit);
    this.el.challengeCancel.addEventListener('click', this.onChallengeCancel);
    this.el.rematchButton.addEventListener('click', this.onRematch);
    this.el.challengeExit.addEventListener('click', this.onChallengeExit);

    this.el.nameForm.addEventListener('submit', this.onSubmitName);
    this.el.continueButton.addEventListener('click', this.onContinue);
    this.el.abandonButton.addEventListener('click', this.onAbandon);
    this.el.newPlayerButton.addEventListener('click', this.onNewPlayer);
    this.el.soundToggle.addEventListener('click', this.onToggleSound);
  }

  destroy() {
    this.el.challengeForm.removeEventListener('submit', this.onChallengeSubmit);
    this.el.challengeCancel.removeEventListener('click', this.onChallengeCancel);
    this.el.rematchButton.removeEventListener('click', this.onRematch);
    this.el.challengeExit.removeEventListener('click', this.onChallengeExit);
    clearTimeout(this.countdownTimer);
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
      this.el.newPlayerButton,
      this.el.challengeStart,
      this.el.rematchButton
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

      /* Only rows with a recording can be raced. Everything submitted before
         Challenge Mode existed simply has no button, which is the honest
         answer rather than a button that fails when pressed. */
      if (entry.hasReplay && entry.id) {
        row.classList.add('mini-board__row--challengeable');
        const button = el('button', 'mini-board__challenge', 'RACE');
        button.type = 'button';
        button.dataset.entry = entry.id;
        button.dataset.name = entry.name;
        button.dataset.score = String(entry.score);
        row.appendChild(button);
      }

      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);

    /* Early in an event nothing has a recording yet, so the hint would be
       pointing at buttons that are not there. */
    const hint = document.querySelector('.mini-board__hint');
    if (hint) hint.hidden = !list.querySelector('.mini-board__challenge');

    // One delegated listener for the whole list, bound once.
    if (!this.miniBoardBound) {
      this.miniBoardBound = true;
      list.addEventListener('click', (event) => {
        const button = event.target.closest && event.target.closest('.mini-board__challenge');
        if (!button || button.disabled) return;
        this.call('onChallenge', {
          id: button.dataset.entry,
          name: button.dataset.name,
          score: Number(button.dataset.score) || 0
        });
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Challenge Mode                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Drives the stage directly rather than going through render(snapshot).
   *
   * A challenge runs while SessionMachine sits at ATTRACT, so there is no
   * session state to reflect - and deliberately so: a duel must not be able to
   * disturb a three-attempt session.
   */
  setScreen(name) {
    this.el.stage.dataset.screen = name;
  }

  /** The confirmation screen. `opponent` is the leaderboard row being raced. */
  renderChallengeBrief(opponent, ghostVariant, playerVariant, suggestedName) {
    this.unlockAll();
    this.el.briefThemName.textContent = opponent.name;
    this.el.briefTarget.textContent = String(opponent.score);
    this.el.challengeError.hidden = true;
    this.el.challengeError.textContent = '';

    if (suggestedName != null) this.el.challengeName.value = suggestedName;

    // The opponent flew as a specific character; show that face, washed cool.
    // The player's own side shows what they are about to fly as.
    setArt(this.el.briefThemArt, ghostVariant);
    setArt(this.el.briefMeArt, playerVariant);

    this.setScreen('challengeBrief');
    // Focus lands on the name field so a keyboard player can just type.
    try { this.el.challengeName.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  showChallengeError(message) {
    this.el.challengeError.textContent = message;
    this.el.challengeError.hidden = !message;
  }

  /**
   * Runs the pre-run countdown, calling `onDone` after the last beat.
   * Returns a cancel function so a player who walks away does not get a
   * countdown firing into an empty screen.
   */
  runCountdown(onDone) {
    this.setScreen('challengeCountdown');
    const beats = CHALLENGE.countdownBeats;
    let index = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      if (index >= beats.length) {
        onDone();
        return;
      }
      const beat = beats[index];
      // Re-trigger the pop animation on each beat.
      const node = this.el.countdownBeat;
      node.textContent = beat;
      node.dataset.go = String(index === beats.length - 1);
      node.style.animation = 'none';
      void node.offsetWidth;
      node.style.animation = '';
      index += 1;
      this.countdownTimer = setTimeout(tick, CHALLENGE.countdownStepMs);
    };

    clearTimeout(this.countdownTimer);
    tick();

    return () => {
      cancelled = true;
      clearTimeout(this.countdownTimer);
    };
  }

  /** Live head-to-head HUD. Called every frame, so it writes only on change. */
  setVersus(standing) {
    const last = this.lastVersus;
    if (standing.mine !== last.mine) {
      this.el.versusMeScore.textContent = String(standing.mine);
      last.mine = standing.mine;
    }
    if (standing.target !== last.theirs) {
      this.el.versusThemScore.textContent = String(standing.target);
      last.theirs = standing.target;
    }
    if (standing.state !== last.state) {
      this.el.versusStanding.dataset.state = standing.state;
      this.el.versusStanding.textContent = standingText(standing);
      last.state = standing.state;
    }
  }

  /** Names change only when a challenge opens, so this is separate. */
  setVersusIdentity(playerName, opponentName) {
    this.el.versusMeName.textContent = playerName || 'YOU';
    this.el.versusThemName.textContent = opponentName || 'RIVAL';
    this.lastVersus = { mine: -1, theirs: -1, state: '' };
  }

  renderChallengeResult(result) {
    this.unlockAll();

    const won = result.verdict === VERDICT.WON;
    const tied = result.verdict === VERDICT.TIED;

    this.el.verdict.dataset.verdict = result.verdict;
    this.el.verdict.textContent = won ? 'YOU WON' : tied ? 'DEAD HEAT' : 'YOU LOST';

    if (won) {
      this.el.verdictSub.textContent =
        'Beat ' + result.opponentName + ' by ' + result.margin +
        (result.margin === 1 ? ' point' : ' points');
    } else if (tied) {
      this.el.verdictSub.textContent = 'Matched ' + result.opponentName + ' exactly - nobody wins a tie';
    } else {
      const behind = Math.abs(result.margin);
      this.el.verdictSub.textContent =
        result.opponentName + ' held on by ' + behind + (behind === 1 ? ' point' : ' points');
    }

    this.el.pbBadge.hidden = !result.personalBest;
    this.el.crMine.textContent = String(result.mine);
    this.el.crTheirs.textContent = String(result.target);
    this.el.crThemLabel.textContent = result.opponentName;

    this.setScreen('challengeResult');
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

/** The single line of copy that tells a player where they stand. */
function standingText(standing) {
  switch (standing.state) {
    case STANDING.AHEAD:
      return 'AHEAD BY ' + standing.diff;
    case STANDING.LEVEL:
      return 'LEVEL - ONE MORE TO WIN';
    case STANDING.CLEAR:
      // The ghost has crashed: this is the moment the run becomes winnable.
      return 'THEY ARE DOWN - ' + standing.needed + ' TO WIN';
    default:
      return 'NECK AND NECK';
  }
}

/** Puts a character portrait in a brief-screen circle, or clears it. */
function setArt(node, variant) {
  if (!node) return;
  if (!variant || !variant.character || !variant.character.src) {
    node.replaceChildren(document.createTextNode('?'));
    return;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.src = variant.character.src;
  img.addEventListener('error', () => node.replaceChildren(document.createTextNode('?')));
  node.replaceChildren(img);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
