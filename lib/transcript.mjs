/**
 * Reading Claude Code's transcript, which is the only place that records what the
 * terminal did.
 *
 * Two callers want it, for opposite reasons:
 *
 *   the permission hook   before notifying — "has this already been answered here?
 *                         then do not buzz the phone at all"
 *   the reconcile hook    after the fact — "what was decided here, so the history
 *                         can say so"
 *
 * The file is JSONL, one message per line, and a tool call appears twice: as a
 * `tool_use` block in an assistant message, and as a `tool_result` in the user turn
 * that follows. Everything below reads it backwards — the call in question is
 * always the most recent one, and a long session's transcript is large enough that
 * scanning all of it repeatedly would be the most expensive thing either hook does.
 *
 * Nothing here writes, and nothing here throws: a transcript that is missing,
 * truncated, half-written, or in a shape we do not recognise reads as "no
 * information", which both callers already handle.
 */
import { readFileSync } from 'node:fs';

/** Content blocks of one transcript line, whatever nesting that version uses. */
export function contentBlocks(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return []; }
  const content = entry?.message?.content ?? entry?.content;
  return Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [];
}

/** Lines, or null if the file cannot be read at all. */
export function lines(path) {
  try { return readFileSync(path, 'utf8').split('\n'); } catch { return null; }
}

/**
 * How many complete lines the transcript holds right now — the baseline for
 * "what happened next".
 *
 * Counts complete lines, not array entries. A newline-terminated file splits to a
 * trailing empty string, so the naive length is one past the last real line — and
 * a baseline one too high skips the very first thing that arrives after it, which
 * is exactly the event the caller is waiting for.
 */
export function lineCount(path) {
  const all = lines(path);
  if (!all) return 0;
  return all[all.length - 1] === '' ? all.length - 1 : all.length;
}

/**
 * The id of the most recent `tool_use` matching this call.
 *
 * Matched on the fingerprint — name plus a hash of the input — because the tool
 * name alone confuses two Bash calls in one session, which is what a loop looks
 * like. Most recent, because an identical call earlier in the session is a
 * different event with its own result.
 */
export function findToolUseId(all, { tool, fp }, fingerprint) {
  for (let i = all.length - 1; i >= 0; i--) {
    if (!all[i] || !all[i].includes('tool_use')) continue;
    for (const block of contentBlocks(all[i])) {
      if (block.type !== 'tool_use' || block.name !== tool) continue;
      if (fingerprint(block.name, block.input) === fp) return block.id;
    }
  }
  return null;
}

/**
 * The result block for a tool_use id, searching only from `from` onwards.
 *
 * `from` is what makes this safe to ask during a live prompt. The same command run
 * earlier in the session already has a result sitting in the file, and treating
 * that as an answer to *this* prompt would silently skip the notification. So the
 * caller pins a baseline before it starts waiting, and only what arrives after it
 * counts as news.
 */
export function findResult(all, useId, from = 0) {
  for (let i = all.length - 1; i >= from; i--) {
    if (!all[i] || !all[i].includes(useId)) continue;
    for (const block of contentBlocks(all[i])) {
      if (block.type === 'tool_result' && block.tool_use_id === useId) return block;
    }
  }
  return null;
}

/** The result's text, however this version nests it. */
function resultText(block) {
  const c = block.content;
  return (Array.isArray(c)
    ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join(' ')
    : typeof c === 'string' ? c : JSON.stringify(c ?? ''))
    .slice(0, 2000);
}

/**
 * Refused, or ran?
 *
 * Claude Code writes the refusal itself, and its wording is stable enough to match
 * on. Anything we do not recognise returns null rather than being rounded to a
 * verdict — an unrecognised result is the one case where answering would put a
 * decision in the history that the user never made.
 */
export function classifyResult(block) {
  const text = resultText(block);

  if (/user (?:doesn't want|does not want|denied|rejected|declined)|tool use was rejected|permission denied by user/i
    .test(text)) {
    return { outcome: 'deny', note: 'Denied in the terminal' };
  }
  // "Request interrupted by user" is not a denial — escape says "not now", not
  // "no". It gets no verdict, and the row keeps saying it was withdrawn.
  if (/interrupted by user/i.test(text)) return null;
  if (block.is_error) return null;
  return { outcome: 'allow', note: 'Approved in the terminal' };
}

/**
 * What the terminal did with this call, or null if the transcript does not say.
 *
 * Null covers three different silences on purpose — no transcript, no matching
 * call, no result yet — because all three mean the same thing to both callers:
 * nothing has been decided here that we can prove.
 */
export function outcomeFor(path, trace, fingerprint, from = 0) {
  const all = lines(path);
  if (!all) return null;
  const useId = findToolUseId(all, trace, fingerprint);
  if (!useId) return null;
  const result = findResult(all, useId, from);
  return result ? classifyResult(result) : null;
}

/**
 * Has this call been answered in the terminal since `from`?
 *
 * Deliberately broader than `outcomeFor`: an interruption is not a verdict, but it
 * absolutely is a reason not to buzz a phone about a prompt nobody is waiting on
 * any more. So any result at all counts here.
 */
export function answeredSince(path, trace, fingerprint, from) {
  const all = lines(path);
  if (!all) return false;
  const useId = findToolUseId(all, trace, fingerprint);
  return !!useId && !!findResult(all, useId, from);
}
