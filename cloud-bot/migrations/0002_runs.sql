-- One row per minute that has been handled. The primary key stops the same
-- minute from being traded twice, even if two runs overlap or a run repeats.
CREATE TABLE IF NOT EXISTS runs (
  ts INTEGER PRIMARY KEY
);
