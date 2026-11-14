/**
 * The shape of an event id, shared by the publisher that issues ids and the contract that bounds what a client may send back, so neither can drift from the other.
 */

/** Bytes of randomness in a publisher's instance; the instance is their hex form. */
export const INSTANCE_BYTES = 8;

/** The separator between an id's instance and its sequence number. Hex never contains it. */
export const ID_SEPARATOR = ".";

/** Characters of an instance: two hex digits per byte. */
const INSTANCE_LENGTH = INSTANCE_BYTES * 2;

/** The longest id a publisher can issue: its instance, the separator and the digits of the largest sequence number a JavaScript number holds exactly. A longer string cannot be an id of any publisher. */
export const MAX_EVENT_ID_LENGTH =
  INSTANCE_LENGTH +
  ID_SEPARATOR.length +
  String(Number.MAX_SAFE_INTEGER).length;
