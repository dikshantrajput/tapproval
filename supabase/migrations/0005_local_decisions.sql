-- Three more terminal statuses, for the decisions that never touched the phone.
--
-- Until now the history only told half the story. A prompt that reached the phone
-- and was tapped landed as `allow`/`deny`/`answer`; a prompt you answered at the
-- keyboard instead landed as `cancelled` — which says "your machine stopped
-- waiting" and nothing at all about what you decided. Since most prompts are
-- answered at the keyboard, most of the history was blank.
--
--   local_allow    the tool ran, so the terminal prompt was approved
--   local_answer   AskUserQuestion returned a selection made in the terminal
--   local_deny     the transcript shows the call was refused or interrupted
--
-- They are deliberately distinct from `allow`/`deny`/`answer` rather than folded
-- into them. "Who decided this, and where" is the question the history exists to
-- answer — a phone tap and a keypress are not the same event, and the audit trail
-- should not have to guess. `decided_by` cannot carry the distinction either: it
-- references `phones`, and there is no phone here.
--
-- `cancelled` survives and keeps its old meaning, narrowed to the truth: we
-- stopped waiting and never found out what happened.

alter table public.requests
  drop constraint if exists requests_status_check;

alter table public.requests
  add constraint requests_status_check
  check (status in (
    'pending', 'allow', 'deny', 'expired', 'cancelled', 'answer',
    'local_allow', 'local_deny', 'local_answer'
  ));

-- `local_answer` carries its selection the same way `answer` does: sealed with the
-- device's payload key, opaque to the server. So it joins the same invariant —
-- an answer status must have an answer, and nothing else may carry one.
alter table public.requests
  drop constraint if exists requests_answer_payload_check;

alter table public.requests
  add constraint requests_answer_payload_check
  check (
    (status in ('answer', 'local_answer') and answer_ciphertext is not null)
    or (status not in ('answer', 'local_answer') and answer_ciphertext is null)
  );

-- Where the decision was made, for the rows that predate this column and for the
-- ones that will never have a phone attached. Derived from `status`, kept as its
-- own column so a query can filter on it without knowing every status name.
alter table public.requests
  add column if not exists decided_on text
    check (decided_on is null or decided_on in ('phone', 'terminal'));

comment on column public.requests.decided_on is
  'phone = tapped a notification or the PWA; terminal = answered at the keyboard.';
