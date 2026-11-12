-- =====================================================================
--  File   : 07_seed_reference.sql
--  Purpose: Reference / lookup data that is part of the schema rather
--           than generated sample data. Safe to re-run (idempotent).
--
--  Bulk sample data (players, tournaments, hands, embeddings) is created
--  by scripts/seed.mjs because it needs the embedding model in JS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Venues
-- ---------------------------------------------------------------------
INSERT INTO venue (venue_name, address_line, city, country, table_capacity) VALUES
    ('Pinnacle Card Room',  '14 MG Road',             'Bengaluru', 'IN', 40),
    ('Marina Bay Poker Club','88 Marina Boulevard',   'Singapore', 'SG', 60),
    ('Thames Riverside Club','5 Embankment Walk',     'London',    'GB', 32),
    ('Oceanview Casino',    '220 Beach Promenade',    'Goa',       'IN', 48),
    ('Alpine Poker Lodge',  '7 Bergstrasse',          'Zurich',    'CH', 24)
ON CONFLICT (venue_name, city) DO NOTHING;

-- ---------------------------------------------------------------------
-- Seasons
-- ---------------------------------------------------------------------
INSERT INTO season (season_name, start_date, end_date) VALUES
    ('Spring Series 2026', DATE '2026-01-05', DATE '2026-04-30'),
    ('Summer Series 2026', DATE '2026-05-01', DATE '2026-08-31'),
    ('Autumn Series 2026', DATE '2026-09-01', DATE '2026-12-20')
ON CONFLICT (season_name) DO NOTHING;

-- ---------------------------------------------------------------------
-- A reusable payout ladder, applied to each tournament by the seeder.
-- Kept here as documentation of the standard structure.
--   rank 1 .. 1   -> 30.0%
--   rank 2 .. 2   -> 20.0%
--   rank 3 .. 3   -> 13.0%
--   rank 4 .. 5   ->  8.0% each
--   rank 6 .. 9   ->  5.0% each   (total = 30+20+13+16+20 = 99%)
-- ---------------------------------------------------------------------
