/**
 * Player identity and contact rules - shared by the browser and the server.
 *
 * This lives under public/ for one concrete reason: the browser can only fetch
 * modules the static server serves, and that is ./public. Node has no such
 * limit, so lib/board.mjs imports from here rather than the other way round.
 * The form and the server therefore validate with the same code, and a number
 * that the form accepted cannot be rejected on arrival.
 *
 * Depends on nothing, so it can sit at the bottom of the import graph.
 */

export const MAX_NAME_LENGTH = 14;
export const MAX_BITS_ID_LENGTH = 20;
export const MIN_BITS_ID_LENGTH = 6;
/** E.164 allows at most 15 digits in total, country code included. */
export const MAX_PHONE_DIGITS = 15;
export const MIN_PHONE_DIGITS = 7;

/** Dial codes offered at the stall, commonest for this campus first. */
export const DIAL_CODES = Object.freeze([
  { code: '+971', label: 'UAE' },
  { code: '+91', label: 'India' },
  { code: '+966', label: 'Saudi Arabia' },
  { code: '+965', label: 'Kuwait' },
  { code: '+974', label: 'Qatar' },
  { code: '+973', label: 'Bahrain' },
  { code: '+968', label: 'Oman' },
  { code: '+44', label: 'UK' },
  { code: '+1', label: 'US / Canada' }
]);

const DIAL_CODE_SET = new Set(DIAL_CODES.map((entry) => entry.code));

function stripControlCharacters(value) {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    // C0 controls, DEL and the C1 block: never legitimate in a display name.
    if (code < 32 || (code >= 127 && code <= 159)) continue;
    out += ch;
  }
  return out;
}

export function sanitiseName(value) {
  const cleaned = stripControlCharacters(String(value == null ? '' : value))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || 'PLAYER';
}

/**
 * A BITS ID, uppercased and stripped of separators.
 *
 * Deliberately permissive about shape: this campus writes f20230346 while
 * others write 2023A7PS0123U, and a guest or transfer student may have
 * neither. Length and character class are enough - the phone number is what
 * actually reaches a winner, and turning away a real student at a busy stall
 * costs more than accepting an odd-looking id.
 */
export function sanitiseBitsId(value) {
  return String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, MAX_BITS_ID_LENGTH);
}

export function validateBitsId(value) {
  const id = sanitiseBitsId(value);
  if (!id) return { ok: false, value: '', error: 'Enter your BITS ID' };
  if (id.length < MIN_BITS_ID_LENGTH) {
    return { ok: false, value: id, error: 'That BITS ID looks too short' };
  }
  return { ok: true, value: id, error: '' };
}

/**
 * Joins a picked dial code to a typed local number.
 *
 * The code is picked rather than typed because a bare ten digit number is
 * genuinely ambiguous between +971 and +91, and guessing wrong means the prize
 * never reaches anybody.
 */
export function validatePhone(dialCode, localNumber) {
  const code = String(dialCode || '').trim();
  if (!DIAL_CODE_SET.has(code)) {
    return { ok: false, value: '', error: 'Pick a country code' };
  }

  /* A leading zero is a domestic trunk prefix and is never part of the
     international number: 050 123 4567 dials as +971 50 123 4567. */
  const digits = String(localNumber == null ? '' : localNumber)
    .replace(/\D/g, '')
    .replace(/^0+/, '');

  if (!digits) return { ok: false, value: '', error: 'Enter your WhatsApp number' };

  const codeDigits = code.replace('+', '').length;
  const total = codeDigits + digits.length;

  if (total < MIN_PHONE_DIGITS) {
    return { ok: false, value: '', error: 'That number looks too short' };
  }
  if (total > MAX_PHONE_DIGITS) {
    return { ok: false, value: '', error: 'That number looks too long' };
  }

  return { ok: true, value: code + digits, error: '' };
}

/**
 * Validates an already-complete international number, e.g. "+971501234567".
 *
 * Needed because this runs in two places with different inputs: the form hands
 * over a picked code and a typed local number, while the server receives the
 * combined result the form produced. Without this the server would treat a
 * full number as a local one and prepend the code a second time, quietly
 * turning every winner's number into something unreachable.
 */
export function validateFullPhone(value) {
  const text = String(value == null ? '' : value).trim();
  const digits = text.replace(/\D/g, '');

  if (!digits) return { ok: false, value: '', error: 'Enter your WhatsApp number' };
  if (digits.length < MIN_PHONE_DIGITS) {
    return { ok: false, value: '', error: 'That number looks too short' };
  }
  if (digits.length > MAX_PHONE_DIGITS) {
    return { ok: false, value: '', error: 'That number looks too long' };
  }
  return { ok: true, value: '+' + digits, error: '' };
}

/**
 * Validates a whole entry. Returns the cleaned values plus a map of field
 * errors, so the form can mark every bad field at once rather than making a
 * player fix them one at a time with the queue waiting.
 *
 * `phone` may be either a local number to be joined to `dialCode`, or a
 * complete number already carrying its own `+`.
 */
export function validateContact({ name, bitsId, dialCode, phone }) {
  const errors = {};

  /* sanitiseName falls back to PLAYER, which is right for a leaderboard row
     but not for a prize draw - here an empty box is an error. */
  if (!String(name == null ? '' : name).trim()) errors.name = 'Enter your name';

  const id = validateBitsId(bitsId);
  if (!id.ok) errors.bitsId = id.error;

  /* A leading + means the number is already complete - re-joining it to the
     dial code would double the country code. */
  const alreadyInternational = String(phone == null ? '' : phone).trim().startsWith('+');
  const tel = alreadyInternational
    ? validateFullPhone(phone)
    : validatePhone(dialCode, phone);
  if (!tel.ok) errors.phone = tel.error;

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    contact: {
      name: sanitiseName(name),
      bitsId: id.value,
      phone: tel.value,
      dialCode: String(dialCode || '')
    }
  };
}
