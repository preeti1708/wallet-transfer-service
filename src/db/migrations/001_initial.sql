CREATE TABLE IF NOT EXISTS wallets (
  id uuid PRIMARY KEY,
  user_id text NOT NULL UNIQUE,
  balance_paise bigint NOT NULL CHECK (balance_paise >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transfers (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  from_wallet_id uuid NOT NULL REFERENCES wallets(id),
  to_wallet_id uuid NOT NULL REFERENCES wallets(id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'declined')),
  decline_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_wallet_id <> to_wallet_id),
  CHECK (
    (status = 'declined' AND decline_reason IS NOT NULL)
    OR (status <> 'declined' AND decline_reason IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS transfers_from_wallet_id_idx ON transfers(from_wallet_id);
CREATE INDEX IF NOT EXISTS transfers_to_wallet_id_idx ON transfers(to_wallet_id);
