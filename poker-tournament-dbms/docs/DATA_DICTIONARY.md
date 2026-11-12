# Data dictionary

> Generated directly from the live PostgreSQL schema by
> `node scripts/gen-data-dictionary.mjs`, so it cannot drift from
> the database. Regenerate after any schema change.

**19 tables · 147 columns · 106 constraints · 63 indexes**

## Table index

| Table | Purpose | Columns | Rows |
|---|---|---:|---:|
| [`app_user`](#appuser) | Authentication identity for every human using the system. | 7 | 73 |
| [`audit_log`](#auditlog) | Append-only trail written by triggers. Deliberately has no FK. | 8 | 865 |
| [`blind_level`](#blindlevel) | WEAK. Blind structure; PK (tournament_id, level_no). | 7 | 162 |
| [`chip_count_log`](#chipcountlog) | Stack snapshot per entry per blind level. | 6 | 1969 |
| [`hand`](#hand) | One dealt hand. | 11 | 770 |
| [`hand_action`](#handaction) | WEAK. Every bet, call, raise and fold. Largest table. | 9 | 4152 |
| [`hand_player`](#handplayer) | ASSOCIATIVE. Resolves M:N between registration and hand. | 9 | 2458 |
| [`hand_summary`](#handsummary) | VECTOR LAYER. Narrative + embedding + metadata, 1:1 with hand. | 10 | 770 |
| [`payout_tier`](#payouttier) | WEAK. Prize ladder; PK (tournament_id, rank_from). | 4 | 45 |
| [`player`](#player) | Competitor domain identity. 1:1 optional with app_user. | 10 | 70 |
| [`player_phone`](#playerphone) | WEAK. Multivalued attribute "phone" realised as its own relation. | 3 | 104 |
| [`poker_table`](#pokertable) | WEAK. A physical table within one tournament. | 6 | 33 |
| [`registration`](#registration) | PIVOT ENTITY. One entry by one player into one tournament. | 13 | 261 |
| [`season`](#season) | Named competitive period grouping tournaments. | 4 | 3 |
| [`seat_assignment`](#seatassignment) | Which entry occupies which seat, and when. | 6 | 291 |
| [`staff`](#staff) | Dealers, floor managers and tournament directors. | 5 | 15 |
| [`tournament`](#tournament) | The central event entity. | 16 | 9 |
| [`tournament_transaction`](#tournamenttransaction) | WEAK. Money in and out, tied to an entry. | 7 | 333 |
| [`venue`](#venue) | Physical card room hosting tournaments. | 6 | 5 |

### Key to the Keys column

`PK` primary key · `FK` foreign key · `UK` part of a unique constraint · `GEN` generated column

---

## app_user

Authentication identity for every human using the system.

*Authentication identity for every human using the system.*

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `user_id` | `integer` | NO | `nextval('app_user_user_id_seq'::re` | PK |  |
| 2 | `email` | `character varying(120)` | NO |  | UK |  |
| 3 | `password_hash` | `character varying(255)` | NO |  |  | bcrypt hash, cost 10. Plaintext is never stored. |
| 4 | `role` | `user_role` | NO | `'PLAYER'::user_role` |  | ADMIN \| DIRECTOR \| PLAYER — drives application and database role selection. |
| 5 | `is_active` | `boolean` | NO | `true` |  |  |
| 6 | `created_at` | `timestamp with time zone` | NO | `now()` |  |  |
| 7 | `last_login_at` | `timestamp with time zone` | YES |  |  |  |

**Primary key:** (`user_id`)

**Unique constraints:**

- `uq_app_user_email` — (`email`)

**Check constraints:**

- `ck_app_user_email_fmt` — `((((email)::text = lower((email)::text)) AND ((email)::text ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'::text)))`
- `ck_app_user_hash_len` — `((char_length((password_hash)::text) >= 20))`

**Indexes:**

- `app_user_pkey` — B-tree (unique)
- `uq_app_user_email` — B-tree (unique)

---

## audit_log

Append-only trail written by triggers. Deliberately has no FK.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `audit_id` | `bigint` | NO | `nextval('audit_log_audit_id_seq'::` | PK |  |
| 2 | `table_name` | `character varying(60)` | NO |  |  |  |
| 3 | `operation` | `character varying(10)` | NO |  |  |  |
| 4 | `row_pk` | `character varying(60)` | NO |  |  |  |
| 5 | `changed_by` | `character varying(80)` | NO | `CURRENT_USER` |  |  |
| 6 | `changed_at` | `timestamp with time zone` | NO | `now()` |  |  |
| 7 | `old_data` | `jsonb` | YES |  |  | JSONB image of the row before the change. |
| 8 | `new_data` | `jsonb` | YES |  |  | JSONB image of the row after the change. |

**Primary key:** (`audit_id`)

**Check constraints:**

- `ck_audit_op` — `(((operation)::text = ANY ((ARRAY['INSERT'::character varying, 'UPDATE'::character varying, 'DELETE'::character varying])::text[])))`

**Indexes:**

- `audit_log_pkey` — B-tree (unique)
- `ix_audit_table_time` — B-tree

---

## blind_level

WEAK. Blind structure; PK (tournament_id, level_no).

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `tournament_id` | `integer` | NO |  | PK FK→tournament |  |
| 2 | `level_no` | `smallint` | NO |  | PK | Partial key — meaningless without its tournament. |
| 3 | `small_blind` | `integer` | NO |  |  |  |
| 4 | `big_blind` | `integer` | NO |  |  |  |
| 5 | `ante` | `integer` | NO | `0` |  |  |
| 6 | `duration_min` | `smallint` | NO | `20` |  |  |
| 7 | `is_break` | `boolean` | NO | `false` |  |  |

**Primary key:** (`tournament_id`, `level_no`)

**Foreign keys:**

- `fk_blind_level_tournament` — (`tournament_id`) → `tournament`, ON DELETE CASCADE

**Check constraints:**

- `ck_blind_level_no` — `(((level_no >= 1) AND (level_no <= 60)))`
- `ck_blind_duration` — `(((duration_min >= 5) AND (duration_min <= 120)))`
- `ck_blind_bb_gt_sb` — `((big_blind >= small_blind))`
- `ck_blind_positive` — `(((small_blind > 0) AND (big_blind > 0) AND (ante >= 0)))`

**Indexes:**

- `pk_blind_level` — B-tree (unique)

---

## chip_count_log

Stack snapshot per entry per blind level.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `log_id` | `integer` | NO | `nextval('chip_count_log_log_id_seq` | PK |  |
| 2 | `registration_id` | `integer` | NO |  | FK→registration UK |  |
| 3 | `tournament_id` | `integer` | NO |  | FK→blind_level |  |
| 4 | `level_no` | `smallint` | NO |  | FK→blind_level UK |  |
| 5 | `chip_stack` | `integer` | NO |  |  |  |
| 6 | `recorded_at` | `timestamp with time zone` | NO | `now()` |  |  |

**Primary key:** (`log_id`)

**Unique constraints:**

- `uq_chip_snapshot` — (`registration_id`, `level_no`)

**Foreign keys:**

- `fk_chip_registration` — (`registration_id`) → `registration`, ON DELETE CASCADE
- `fk_chip_level` — (`tournament_id`, `level_no`) → `blind_level`, ON DELETE CASCADE

**Check constraints:**

- `ck_chip_stack` — `((chip_stack >= 0))`

**Indexes:**

- `chip_count_log_pkey` — B-tree (unique)
- `ix_chip_reg_level` — B-tree
- `ix_chip_registration` — B-tree
- `uq_chip_snapshot` — B-tree (unique)

---

## hand

One dealt hand.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `hand_id` | `bigint` | NO | `nextval('hand_hand_id_seq'::regcla` | PK |  |
| 2 | `table_id` | `integer` | NO |  | FK→poker_table |  |
| 3 | `tournament_id` | `integer` | NO |  | FK→blind_level |  |
| 4 | `level_no` | `smallint` | NO |  | FK→blind_level |  |
| 5 | `hand_no` | `integer` | NO |  |  |  |
| 6 | `board_cards` | `character varying(14)` | YES |  |  |  |
| 7 | `pot_size` | `numeric(12,0)` | NO | `0` |  |  |
| 8 | `rake_taken` | `numeric(10,2)` | NO | `0` |  |  |
| 9 | `went_to_showdown` | `boolean` | NO | `false` |  |  |
| 10 | `started_at` | `timestamp with time zone` | NO | `now()` |  |  |
| 11 | `ended_at` | `timestamp with time zone` | YES |  |  |  |

**Primary key:** (`hand_id`)

**Foreign keys:**

- `fk_hand_table` — (`table_id`) → `poker_table`, ON DELETE CASCADE
- `fk_hand_level` — (`tournament_id`, `level_no`) → `blind_level`, ON DELETE CASCADE

**Check constraints:**

- `ck_hand_pot` — `((pot_size >= (0)::numeric))`
- `ck_hand_board` — `(((board_cards IS NULL) OR ((board_cards)::text ~ '^([2-9TJQKA][shdc])( [2-9TJQKA][shdc]){2,4}$'::text)))`
- `ck_hand_no` — `((hand_no >= 1))`
- `ck_hand_times` — `(((ended_at IS NULL) OR (ended_at >= started_at)))`

**Indexes:**

- `hand_pkey` — B-tree (unique)
- `ix_hand_pot_desc` — B-tree
- `ix_hand_table` — B-tree
- `uq_hand_per_table` — B-tree (unique)

---

## hand_action

WEAK. Every bet, call, raise and fold. Largest table.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `action_id` | `bigint` | NO | `nextval('hand_action_action_id_seq` | PK |  |
| 2 | `hand_id` | `bigint` | NO |  | FK→hand UK |  |
| 3 | `hand_player_id` | `bigint` | NO |  | FK→hand_player |  |
| 4 | `street` | `street_type` | NO |  |  |  |
| 5 | `action_seq` | `smallint` | NO |  | UK |  |
| 6 | `action` | `action_type` | NO |  |  |  |
| 7 | `amount` | `numeric(12,0)` | NO | `0` |  |  |
| 8 | `pot_after` | `numeric(12,0)` | NO | `0` |  |  |
| 9 | `think_time_sec` | `smallint` | NO | `0` |  |  |

**Primary key:** (`action_id`)

**Unique constraints:**

- `uq_action_sequence` — (`hand_id`, `action_seq`)

**Foreign keys:**

- `fk_action_hand_player` — (`hand_player_id`) → `hand_player`, ON DELETE CASCADE
- `fk_action_hand` — (`hand_id`) → `hand`, ON DELETE CASCADE

**Check constraints:**

- `ck_action_think` — `(((think_time_sec >= 0) AND (think_time_sec <= 600)))`
- `ck_action_passive` — `(((action <> ALL (ARRAY['FOLD'::action_type, 'CHECK'::action_type])) OR (amount = (0)::numeric)))`
- `ck_action_amount` — `((amount >= (0)::numeric))`

**Indexes:**

- `hand_action_pkey` — B-tree (unique)
- `ix_action_hand_player` — B-tree
- `ix_action_hand_seq` — B-tree
- `uq_action_sequence` — B-tree (unique)

---

## hand_player

ASSOCIATIVE. Resolves M:N between registration and hand.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `hand_player_id` | `bigint` | NO | `nextval('hand_player_hand_player_i` | PK |  |
| 2 | `hand_id` | `bigint` | NO |  | FK→hand UK |  |
| 3 | `registration_id` | `integer` | NO |  | FK→registration UK |  |
| 4 | `seat_no` | `smallint` | NO |  | UK |  |
| 5 | `hole_cards` | `character varying(8)` | YES |  |  |  |
| 6 | `is_dealer` | `boolean` | NO | `false` |  |  |
| 7 | `chips_before` | `integer` | NO |  |  |  |
| 8 | `chips_after` | `integer` | NO |  |  |  |
| 9 | `net_result` | `integer` | YES | `(chips_after - chips_before)` | GEN | GENERATED column (chips_after - chips_before). Cannot drift. |

**Primary key:** (`hand_player_id`)

**Unique constraints:**

- `uq_hp_hand_player` — (`hand_id`, `registration_id`)
- `uq_hp_hand_seat` — (`hand_id`, `seat_no`)

**Foreign keys:**

- `fk_hp_hand` — (`hand_id`) → `hand`, ON DELETE CASCADE
- `fk_hp_registration` — (`registration_id`) → `registration`, ON DELETE CASCADE

**Check constraints:**

- `ck_hp_hole` — `(((hole_cards IS NULL) OR ((hole_cards)::text ~ '^[2-9TJQKA][shdc] [2-9TJQKA][shdc]$'::text)))`
- `ck_hp_chips` — `(((chips_before >= 0) AND (chips_after >= 0)))`

**Indexes:**

- `hand_player_pkey` — B-tree (unique)
- `ix_hp_registration` — B-tree
- `uq_hp_hand_player` — B-tree (unique)
- `uq_hp_hand_seat` — B-tree (unique)

---

## hand_summary

VECTOR LAYER. Narrative + embedding + metadata, 1:1 with hand.

*Vector-database component. One embedded narrative per hand; supports create/read/update/delete plus cosine similarity search.*

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `summary_id` | `bigint` | NO | `nextval('hand_summary_summary_id_s` | PK |  |
| 2 | `hand_id` | `bigint` | NO |  | FK→hand UK |  |
| 3 | `summary_text` | `text` | NO |  |  |  |
| 4 | `embedding` | `vector(256)` | NO |  |  | 256-dimension L2-normalised vector; HNSW index with vector_cosine_ops. |
| 5 | `model_name` | `character varying(60)` | NO | `'lexical-hash-256-v1'::character v` |  |  |
| 6 | `metadata` | `jsonb` | NO | `'{}'::jsonb` |  | JSONB facets used to pre-filter before the ANN ordering. |
| 7 | `search_tsv` | `tsvector` | YES | `to_tsvector('english'::regconfig, ` | GEN | GENERATED tsvector for lexical search; GIN indexed. |
| 8 | `created_at` | `timestamp with time zone` | NO | `now()` |  |  |
| 9 | `updated_at` | `timestamp with time zone` | NO | `now()` |  |  |
| 10 | `token_count` | `integer` | NO | `0` |  | Recomputed by trigger tr_summary_touch on every write. |

**Primary key:** (`summary_id`)

**Unique constraints:**

- `uq_summary_hand` — (`hand_id`)

**Foreign keys:**

- `fk_summary_hand` — (`hand_id`) → `hand`, ON DELETE CASCADE

**Check constraints:**

- `ck_summary_len` — `(((char_length(summary_text) >= 10) AND (char_length(summary_text) <= 4000)))`

**Indexes:**

- `hand_summary_pkey` — B-tree (unique)
- `ix_summary_embedding_hnsw` — HNSW
- `ix_summary_fts` — GIN
- `ix_summary_metadata` — GIN
- `uq_summary_hand` — B-tree (unique)

---

## payout_tier

WEAK. Prize ladder; PK (tournament_id, rank_from).

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `tournament_id` | `integer` | NO |  | PK FK→tournament |  |
| 2 | `rank_from` | `smallint` | NO |  | PK | Partial key. |
| 3 | `rank_to` | `smallint` | NO |  |  |  |
| 4 | `pct_of_pool` | `numeric(6,3)` | NO |  |  |  |

**Primary key:** (`tournament_id`, `rank_from`)

**Foreign keys:**

- `fk_payout_tier_tournament` — (`tournament_id`) → `tournament`, ON DELETE CASCADE

**Check constraints:**

- `ck_payout_range` — `(((rank_to >= rank_from) AND (rank_from >= 1)))`
- `ck_payout_pct` — `(((pct_of_pool > (0)::numeric) AND (pct_of_pool <= (100)::numeric)))`

**Indexes:**

- `pk_payout_tier` — B-tree (unique)

---

## player

Competitor domain identity. 1:1 optional with app_user.

*Competitor. age is DERIVED from date_of_birth (see v_player_profile).*

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `player_id` | `integer` | NO | `nextval('player_player_id_seq'::re` | PK |  |
| 2 | `user_id` | `integer` | YES |  | FK→app_user UK |  |
| 3 | `screen_name` | `character varying(40)` | NO |  | UK |  |
| 4 | `first_name` | `character varying(50)` | NO |  |  |  |
| 5 | `last_name` | `character varying(50)` | NO |  |  |  |
| 6 | `date_of_birth` | `date` | NO |  |  | age is DERIVED from this by fn_player_age(); age is never stored. |
| 7 | `country` | `character(2)` | NO |  |  |  |
| 8 | `lifetime_earnings` | `numeric(12,2)` | NO | `0.00` |  | Maintained by trigger tr_sync_player_earnings; never written by hand. |
| 9 | `ranking_points` | `integer` | NO | `0` |  |  |
| 10 | `created_at` | `timestamp with time zone` | NO | `now()` |  |  |

**Primary key:** (`player_id`)

**Unique constraints:**

- `uq_player_screen_name` — (`screen_name`)
- `uq_player_user` — (`user_id`)

**Foreign keys:**

- `fk_player_user` — (`user_id`) → `app_user`, ON DELETE SET NULL

**Check constraints:**

- `ck_player_adult` — `((date_of_birth <= (CURRENT_DATE - '18 years'::interval)))`
- `ck_player_points` — `((ranking_points >= 0))`
- `ck_player_earnings` — `((lifetime_earnings >= (0)::numeric))`
- `ck_player_country` — `((country ~ '^[A-Z]{2}$'::text))`

**Indexes:**

- `ix_player_screen_lower` — B-tree
- `ix_player_user` — B-tree
- `player_pkey` — B-tree (unique)
- `uq_player_screen_name` — B-tree (unique)
- `uq_player_user` — B-tree (unique)

---

## player_phone

WEAK. Multivalued attribute "phone" realised as its own relation.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `player_id` | `integer` | NO |  | PK FK→player |  |
| 2 | `phone` | `character varying(20)` | NO |  | PK | Partial key. Realises the multivalued ER attribute "phone". |
| 3 | `is_primary` | `boolean` | NO | `false` |  |  |

**Primary key:** (`player_id`, `phone`)

**Foreign keys:**

- `fk_player_phone` — (`player_id`) → `player`, ON DELETE CASCADE

**Check constraints:**

- `ck_phone_fmt` — `(((phone)::text ~ '^\+?[0-9]{7,15}$'::text))`

**Indexes:**

- `pk_player_phone` — B-tree (unique)
- `uq_player_primary_phone` — B-tree (partial)

---

## poker_table

WEAK. A physical table within one tournament.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `table_id` | `integer` | NO | `nextval('poker_table_table_id_seq'` | PK |  |
| 2 | `tournament_id` | `integer` | NO |  | FK→tournament UK |  |
| 3 | `table_no` | `smallint` | NO |  | UK | Partial key. table_id is a surrogate so child rows get a single-column FK. |
| 4 | `max_seats` | `smallint` | NO | `9` |  |  |
| 5 | `dealer_id` | `integer` | YES |  | FK→staff |  |
| 6 | `status` | `table_status` | NO | `'OPEN'::table_status` |  |  |

**Primary key:** (`table_id`)

**Unique constraints:**

- `uq_poker_table_natural` — (`tournament_id`, `table_no`)

**Foreign keys:**

- `fk_table_tournament` — (`tournament_id`) → `tournament`, ON DELETE CASCADE
- `fk_table_dealer` — (`dealer_id`) → `staff`, ON DELETE SET NULL

**Check constraints:**

- `ck_table_no` — `(((table_no >= 1) AND (table_no <= 200)))`
- `ck_table_seats` — `(((max_seats >= 2) AND (max_seats <= 10)))`

**Indexes:**

- `ix_table_tournament` — B-tree
- `poker_table_pkey` — B-tree (unique)
- `uq_poker_table_natural` — B-tree (unique)

---

## registration

PIVOT ENTITY. One entry by one player into one tournament.

*One entry into one tournament. Pivot entity: seats, chips, hands and results all hang off the ENTRY, not the person, so re-entry works.*

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `registration_id` | `integer` | NO | `nextval('registration_registration` | PK |  |
| 2 | `tournament_id` | `integer` | NO |  | FK→tournament UK |  |
| 3 | `player_id` | `integer` | NO |  | FK→player UK |  |
| 4 | `entry_type` | `entry_type` | NO | `'BUYIN'::entry_type` |  |  |
| 5 | `entry_no` | `smallint` | NO | `1` | UK | Distinguishes re-entries by the same player in one tournament. |
| 6 | `registered_at` | `timestamp with time zone` | NO | `now()` |  |  |
| 7 | `chip_stack` | `integer` | NO | `0` |  | Live stack during play; snapshots per level live in chip_count_log. |
| 8 | `is_active` | `boolean` | NO | `true` |  |  |
| 9 | `finish_rank` | `integer` | YES |  |  |  |
| 10 | `bust_time` | `timestamp with time zone` | YES |  |  |  |
| 11 | `eliminated_by_reg_id` | `integer` | YES |  | FK→registration | Self-referencing FK. Basis of the recursive elimination-chain query. |
| 12 | `prize_won` | `numeric(12,2)` | NO | `0.00` |  |  |
| 13 | `points_awarded` | `integer` | NO | `0` |  |  |

**Primary key:** (`registration_id`)

**Unique constraints:**

- `uq_reg_player_entry` — (`tournament_id`, `player_id`, `entry_no`)

**Foreign keys:**

- `fk_reg_player` — (`player_id`) → `player`, ON DELETE RESTRICT
- `fk_reg_tournament` — (`tournament_id`) → `tournament`, ON DELETE CASCADE
- `fk_reg_eliminator` — (`eliminated_by_reg_id`) → `registration`, ON DELETE SET NULL

**Check constraints:**

- `ck_reg_bust_consistency` — `(((is_active AND (finish_rank IS NULL) AND (bust_time IS NULL)) OR ((NOT is_active) AND (finish_rank IS NOT NULL))))`
- `ck_reg_not_self_ko` — `((eliminated_by_reg_id <> registration_id))`
- `ck_reg_entry_no` — `(((entry_no >= 1) AND (entry_no <= 10)))`
- `ck_reg_stack` — `((chip_stack >= 0))`
- `ck_reg_rank` — `(((finish_rank IS NULL) OR (finish_rank >= 1)))`
- `ck_reg_prize` — `((prize_won >= (0)::numeric))`
- `ck_reg_points` — `((points_awarded >= 0))`

**Indexes:**

- `ix_reg_active_by_tournament` — B-tree (partial)
- `ix_reg_cashed` — B-tree (partial)
- `ix_reg_eliminator` — B-tree
- `ix_reg_player` — B-tree
- `ix_reg_tournament` — B-tree
- `registration_pkey` — B-tree (unique)
- `uq_reg_player_entry` — B-tree (unique)

---

## season

Named competitive period grouping tournaments.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `season_id` | `integer` | NO | `nextval('season_season_id_seq'::re` | PK |  |
| 2 | `season_name` | `character varying(60)` | NO |  | UK |  |
| 3 | `start_date` | `date` | NO |  |  |  |
| 4 | `end_date` | `date` | NO |  |  |  |

**Primary key:** (`season_id`)

**Unique constraints:**

- `uq_season_name` — (`season_name`)

**Check constraints:**

- `ck_season_dates` — `((end_date > start_date))`

**Indexes:**

- `season_pkey` — B-tree (unique)
- `uq_season_name` — B-tree (unique)

---

## seat_assignment

Which entry occupies which seat, and when.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `seat_id` | `integer` | NO | `nextval('seat_assignment_seat_id_s` | PK |  |
| 2 | `table_id` | `integer` | NO |  | FK→poker_table |  |
| 3 | `registration_id` | `integer` | NO |  | FK→registration |  |
| 4 | `seat_no` | `smallint` | NO |  |  |  |
| 5 | `assigned_at` | `timestamp with time zone` | NO | `now()` |  |  |
| 6 | `vacated_at` | `timestamp with time zone` | YES |  |  | NULL means the seat is occupied NOW. Partial unique indexes depend on this. |

**Primary key:** (`seat_id`)

**Foreign keys:**

- `fk_seat_table` — (`table_id`) → `poker_table`, ON DELETE CASCADE
- `fk_seat_registration` — (`registration_id`) → `registration`, ON DELETE CASCADE

**Check constraints:**

- `ck_seat_no` — `(((seat_no >= 1) AND (seat_no <= 10)))`
- `ck_seat_times` — `(((vacated_at IS NULL) OR (vacated_at >= assigned_at)))`

**Indexes:**

- `ix_seat_registration` — B-tree
- `seat_assignment_pkey` — B-tree (unique)
- `uq_seat_live_entry` — B-tree (partial)
- `uq_seat_live_occupancy` — B-tree (partial)

---

## staff

Dealers, floor managers and tournament directors.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `staff_id` | `integer` | NO | `nextval('staff_staff_id_seq'::regc` | PK |  |
| 2 | `user_id` | `integer` | YES |  | FK→app_user UK |  |
| 3 | `full_name` | `character varying(100)` | NO |  |  |  |
| 4 | `designation` | `staff_designation` | NO |  |  |  |
| 5 | `hired_on` | `date` | NO | `CURRENT_DATE` |  |  |

**Primary key:** (`staff_id`)

**Unique constraints:**

- `uq_staff_user` — (`user_id`)

**Foreign keys:**

- `fk_staff_user` — (`user_id`) → `app_user`, ON DELETE SET NULL

**Check constraints:**

- `ck_staff_hired` — `((hired_on <= CURRENT_DATE))`

**Indexes:**

- `staff_pkey` — B-tree (unique)
- `uq_staff_user` — B-tree (unique)

---

## tournament

The central event entity.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `tournament_id` | `integer` | NO | `nextval('tournament_tournament_id_` | PK |  |
| 2 | `venue_id` | `integer` | NO |  | FK→venue |  |
| 3 | `season_id` | `integer` | YES |  | FK→season |  |
| 4 | `created_by` | `integer` | YES |  | FK→staff |  |
| 5 | `title` | `character varying(120)` | NO |  | UK |  |
| 6 | `game_type` | `game_type` | NO | `'NLH'::game_type` |  |  |
| 7 | `format` | `tournament_format` | NO | `'FREEZEOUT'::tournament_format` |  |  |
| 8 | `buy_in` | `numeric(10,2)` | NO |  |  |  |
| 9 | `rake_pct` | `numeric(5,2)` | NO | `10.00` |  | House fee. Makes prize_pool genuinely derivable. |
| 10 | `guarantee` | `numeric(12,2)` | NO | `0.00` |  |  |
| 11 | `starting_stack` | `integer` | NO |  |  |  |
| 12 | `max_entries` | `integer` | NO |  |  |  |
| 13 | `start_time` | `timestamp with time zone` | NO |  |  |  |
| 14 | `status` | `tournament_status` | NO | `'SCHEDULED'::tournament_status` |  |  |
| 15 | `created_at` | `timestamp with time zone` | NO | `now()` |  |  |
| 16 | `entrants_count` | `integer` | NO | `0` |  | Maintained by trigger tr_entrants_count; the field-cap CHECK depends on it. |

**Primary key:** (`tournament_id`)

**Unique constraints:**

- `uq_tournament_title` — (`title`)

**Foreign keys:**

- `fk_tournament_season` — (`season_id`) → `season`, ON DELETE SET NULL
- `fk_tournament_creator` — (`created_by`) → `staff`, ON DELETE SET NULL
- `fk_tournament_venue` — (`venue_id`) → `venue`, ON DELETE RESTRICT

**Check constraints:**

- `ck_tournament_entrants` — `(((entrants_count >= 0) AND (entrants_count <= max_entries)))`
- `ck_tournament_guar` — `((guarantee >= (0)::numeric))`
- `ck_tournament_entries` — `(((max_entries >= 2) AND (max_entries <= 10000)))`
- `ck_tournament_stack` — `((starting_stack >= 1000))`
- `ck_tournament_rake` — `(((rake_pct >= (0)::numeric) AND (rake_pct < (50)::numeric)))`
- `ck_tournament_buyin` — `((buy_in > (0)::numeric))`

**Indexes:**

- `ix_tournament_season` — B-tree
- `ix_tournament_status_start` — B-tree
- `ix_tournament_venue` — B-tree
- `tournament_pkey` — B-tree (unique)
- `uq_tournament_title` — B-tree (unique)

---

## tournament_transaction

WEAK. Money in and out, tied to an entry.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `txn_id` | `integer` | NO | `nextval('tournament_transaction_tx` | PK |  |
| 2 | `registration_id` | `integer` | NO |  | FK→registration |  |
| 3 | `txn_type` | `txn_type` | NO |  |  |  |
| 4 | `amount` | `numeric(12,2)` | NO |  |  |  |
| 5 | `method` | `txn_method` | NO | `'CASH'::txn_method` |  |  |
| 6 | `txn_time` | `timestamp with time zone` | NO | `now()` |  |  |
| 7 | `reference_no` | `uuid` | NO | `gen_random_uuid()` | UK |  |

**Primary key:** (`txn_id`)

**Unique constraints:**

- `uq_txn_reference` — (`reference_no`)

**Foreign keys:**

- `fk_txn_registration` — (`registration_id`) → `registration`, ON DELETE CASCADE

**Check constraints:**

- `ck_txn_amount` — `((amount > (0)::numeric))`

**Indexes:**

- `ix_txn_registration` — B-tree
- `tournament_transaction_pkey` — B-tree (unique)
- `uq_txn_reference` — B-tree (unique)

---

## venue

Physical card room hosting tournaments.

| # | Column | Type | Null | Default | Keys | Notes |
|---:|---|---|---|---|---|---|
| 1 | `venue_id` | `integer` | NO | `nextval('venue_venue_id_seq'::regc` | PK |  |
| 2 | `venue_name` | `character varying(100)` | NO |  | UK |  |
| 3 | `address_line` | `character varying(200)` | NO |  |  |  |
| 4 | `city` | `character varying(60)` | NO |  | UK |  |
| 5 | `country` | `character(2)` | NO |  |  |  |
| 6 | `table_capacity` | `integer` | NO |  |  |  |

**Primary key:** (`venue_id`)

**Unique constraints:**

- `uq_venue_name_city` — (`venue_name`, `city`)

**Check constraints:**

- `ck_venue_capacity` — `(((table_capacity >= 1) AND (table_capacity <= 500)))`
- `ck_venue_country` — `((country ~ '^[A-Z]{2}$'::text))`

**Indexes:**

- `uq_venue_name_city` — B-tree (unique)
- `venue_pkey` — B-tree (unique)

---
