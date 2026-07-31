-- A fifth terminal status: `answer`.
--
-- AskUserQuestion does not ask for permission, it asks for a choice: Claude offers
-- options and wants to know which one. The row still travels the same path — one
-- push, one wait, the same expiry — but what comes back is a selection rather than
-- a verdict, so it needs its own status. Reusing `allow` would have been cheaper
-- and wrong: the hook has to be able to tell "go ahead" from "they picked option
-- two", and a row that says `allow` with no selection attached is exactly the
-- ambiguity that would turn a mis-decrypt into a silently wrong answer.
--
-- `answer_ciphertext` holds the selection under the same envelope as the request
-- itself (AES-256-GCM, key never on the server). Which option a user chose is
-- their content, not ours, so it is not stored in the clear here either.

alter table public.requests
  add column if not exists answer_ciphertext text;

alter table public.requests
  drop constraint if exists requests_status_check;

alter table public.requests
  add constraint requests_status_check
  check (status in ('pending', 'allow', 'deny', 'expired', 'cancelled', 'answer'));

-- An `answer` row must carry its selection, and no other status may carry one.
-- Without this a bug in /api/decide could settle a question with nothing attached,
-- and the hook would be left holding a decision it cannot act on.
alter table public.requests
  drop constraint if exists requests_answer_payload_check;

alter table public.requests
  add constraint requests_answer_payload_check
  check (
    (status = 'answer' and answer_ciphertext is not null)
    or (status <> 'answer' and answer_ciphertext is null)
  );
