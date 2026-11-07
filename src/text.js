/** Small text helpers shared by the panel and the log pipeline. */

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Remove ANSI colour codes (sing-box/mtg paint their stderr). */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '').replace(/\r/g, '');
}

/** One readable line: no ANSI, no newlines, collapsed spaces. */
export function oneLine(text, max = 220) {
  const clean = stripAnsi(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Keep the interesting part of a core's complaint. */
export function coreReason(text, max = 180) {
  const clean = oneLine(text, 400);
  const hit = clean.match(/(unknown field[^,]*|invalid [^,>]{0,90}|failed to [^,>]{0,90}|cannot [^,>]{0,90}|decode config[^,>]{0,90})/i);
  return (hit ? hit[0] : clean).slice(0, max);
}
