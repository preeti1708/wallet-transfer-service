-- Existing migrations and records are preserved. Bound keys in the database,
-- and prevent an accidentally unfinished transfer from being committed.
ALTER TABLE transfers ADD CONSTRAINT transfers_key_format
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 128);

CREATE FUNCTION require_terminal_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Inspect the final row, not NEW from the earlier pending INSERT event.
  IF EXISTS (SELECT 1 FROM transfers WHERE id = NEW.id AND status = 'pending') THEN
    RAISE EXCEPTION 'Transfer must have a terminal outcome before commit'
      USING ERRCODE = '23514', CONSTRAINT = 'transfers_terminal_outcome';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transfers_terminal_outcome
  AFTER INSERT OR UPDATE ON transfers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_terminal_transfer();
