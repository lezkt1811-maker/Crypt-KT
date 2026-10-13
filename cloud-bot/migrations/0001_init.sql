-- Bot state (cash, holdings, P/L counters) as one JSON row.
CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

-- One closing price per minute (minutes since the Unix epoch).
CREATE TABLE IF NOT EXISTS bars (
  ts INTEGER PRIMARY KEY,
  close REAL NOT NULL
);

-- Every decision the bot made, including "watching" minutes.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL
);
