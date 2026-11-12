# Relational schema and ER-to-relational conversion

This document does two things: it records the final relational schema with
every key and constraint, and it shows **how each ER construct was
converted**, which is the step examiners most often ask you to perform live.

---

## Part 1 — The conversion rules, applied

### Rule 1: Each strong entity becomes a relation

Its simple attributes become columns; its key attribute becomes the primary
key.

| ER entity | Relation | Primary key |
|---|---|---|
| `APP_USER` | `app_user` | `user_id` |
| `PLAYER` | `player` | `player_id` |
| `STAFF` | `staff` | `staff_id` |
| `VENUE` | `venue` | `venue_id` |
| `SEASON` | `season` | `season_id` |
| `TOURNAMENT` | `tournament` | `tournament_id` |
| `REGISTRATION` | `registration` | `registration_id` |
| `HAND` | `hand` | `hand_id` |
| `HAND_SUMMARY` | `hand_summary` | `summary_id` |

### Rule 2: Each weak entity becomes a relation whose primary key is the owner's key plus its own partial key

| Weak entity | Owner | Partial key | Resulting primary key |
|---|---|---|---|
| `BLIND_LEVEL` | `TOURNAMENT` | `level_no` | `(tournament_id, level_no)` |
| `PAYOUT_TIER` | `TOURNAMENT` | `rank_from` | `(tournament_id, rank_from)` |
| `PLAYER_PHONE` | `PLAYER` | `phone` | `(player_id, phone)` |
| `POKER_TABLE` | `TOURNAMENT` | `table_no` | `(tournament_id, table_no)` * |

\* `poker_table` additionally carries a surrogate `table_id` as its declared
primary key, with `UNIQUE (tournament_id, table_no)` preserving the natural
key. This is a deliberate, defensible choice: `seat_assignment` and `hand`
both reference a table, and a single-column foreign key is simpler and
cheaper to index than a two-column one. **The natural key is still
enforced** — it is a unique constraint, not an afterthought.

### Rule 3: A composite attribute becomes its leaf columns

| Composite ER attribute | Columns in the relation |
|---|---|
| `PLAYER.full_name` | `first_name`, `last_name` |
| `VENUE.address` | `address_line`, `city`, `country` |

The composite itself is not stored; `v_player_profile` reassembles
`full_name` on read with `first_name || ' ' || last_name`.

### Rule 4: A multivalued attribute becomes its own relation

`PLAYER.phone` is multivalued, so it becomes:

```sql
player_phone(player_id, phone, is_primary)
PRIMARY KEY (player_id, phone)
```

This is the step that keeps the schema in **1NF** — the alternative, a
comma-separated `phones` column, violates atomicity.

`HAND.board_cards` is also multivalued in the ER model but is stored as a
single formatted string (`'Ah Kd 7c 2s'`). This is a **documented,
deliberate denormalisation**: the board is always read as a unit and never
queried by individual card, so a separate `hand_board_card` table would add
a join to every hand read for no query benefit. A `CHECK` constraint with a
regular expression enforces the format, so the column is not a free-text
field.

### Rule 5: A derived attribute is NOT stored

| Derived attribute | How it is computed instead |
|---|---|
| `PLAYER.age` | `fn_player_age(date_of_birth)` |
| `TOURNAMENT.prize_pool` | `fn_prize_pool(tournament_id)` |
| `HAND_PLAYER.net_result` | `GENERATED ALWAYS AS (chips_after - chips_before) STORED` |

The one exception is `tournament.entrants_count`, which *is* stored —
because a `CHECK` constraint cannot count rows in another table, and the
field cap must be enforceable. A trigger maintains it. This trade-off is
stated rather than hidden.

### Rule 6: A 1:1 relationship becomes a foreign key with a UNIQUE constraint

`APP_USER —has_login— PLAYER` is 1:1. The foreign key goes on `player`
(the side with total participation), with `UNIQUE (user_id)` enforcing the
"one" on the other side.

```sql
user_id INTEGER,
CONSTRAINT uq_player_user UNIQUE (user_id),
CONSTRAINT fk_player_user FOREIGN KEY (user_id)
    REFERENCES app_user (user_id) ON DELETE SET NULL
```

Without the `UNIQUE`, this would silently be 1:N.

### Rule 7: A 1:N relationship becomes a foreign key on the N side

| Relationship | Foreign key placed on |
|---|---|
| `VENUE —hosts— TOURNAMENT` | `tournament.venue_id` |
| `SEASON —part_of— TOURNAMENT` | `tournament.season_id` |
| `PLAYER —registers— REGISTRATION` | `registration.player_id` |
| `TOURNAMENT —entry_for— REGISTRATION` | `registration.tournament_id` |
| `STAFF —deals_at— POKER_TABLE` | `poker_table.dealer_id` |

### Rule 8: An M:N relationship becomes its own relation

`REGISTRATION —plays_in— HAND` is M:N. It becomes `hand_player`, carrying
both foreign keys plus the relationship's own attributes:

```sql
hand_player(hand_player_id PK,
            hand_id FK, registration_id FK,
            seat_no, hole_cards, is_dealer,
            chips_before, chips_after, net_result GENERATED)
UNIQUE (hand_id, registration_id)   -- the natural composite key
UNIQUE (hand_id, seat_no)           -- one occupant per seat in a hand
```

A surrogate key is used here because `hand_action` must reference a single
participant, and a one-column foreign key is cleaner. The natural key
`(hand_id, registration_id)` is preserved as a unique constraint.

### Rule 9: A relationship's own attributes travel with it

| Relationship | Attributes | Where they land |
|---|---|---|
| `seated_at` | `seat_no`, `assigned_at`, `vacated_at` | `seat_assignment` |
| `stack_logged` | `level_no`, `chip_stack`, `recorded_at` | `chip_count_log` |
| `participates`/`contests` | `hole_cards`, `chips_before/after` | `hand_player` |

### Rule 10: A recursive relationship becomes a self-referencing foreign key

`REGISTRATION —knocks_out— REGISTRATION` with roles *eliminator* and
*eliminated*:

```sql
eliminated_by_reg_id INTEGER,
CONSTRAINT fk_reg_eliminator FOREIGN KEY (eliminated_by_reg_id)
    REFERENCES registration (registration_id) ON DELETE SET NULL,
CONSTRAINT ck_reg_not_self_ko CHECK (eliminated_by_reg_id <> registration_id)
```

The `CHECK` is necessary because a self-referencing foreign key is
perfectly happy to point a row at itself; the domain is not.

### Rule 11: Total participation becomes NOT NULL

`REGISTRATION` has total participation in both `registers` and `entry_for`,
so `player_id` and `tournament_id` are both `NOT NULL`. Partial
participation stays nullable — `tournament.season_id` is nullable because a
one-off event belongs to no season.

---

## Part 2 — Functional dependencies and normal form

### Example: `registration`

Candidate keys:
- `registration_id` (surrogate)
- `(tournament_id, player_id, entry_no)` (natural)

Non-trivial functional dependencies:

```
registration_id → tournament_id, player_id, entry_type, entry_no,
                  registered_at, chip_stack, is_active, finish_rank,
                  bust_time, eliminated_by_reg_id, prize_won, points_awarded

(tournament_id, player_id, entry_no) → registration_id, (all the rest)
```

Every determinant is a candidate key, so `registration` is in **BCNF**.

Critically, there is **no** dependency such as `player_id → screen_name`,
because `screen_name` is not in this relation — it lives on `player`. Had
it been copied here for convenience, that transitive dependency would break
3NF and allow the same player to have two different names in two entries.

### Example: `blind_level`

```
(tournament_id, level_no) → small_blind, big_blind, ante, duration_min, is_break
```

No non-key attribute depends on only part of the key — `small_blind`
requires both which tournament and which level. Therefore **2NF**, and as
the only determinant is the full key, **BCNF**.

### Summary

| Relation | Highest normal form | Note |
|---|---|---|
| `app_user` | BCNF | |
| `player` | BCNF | |
| `player_phone` | BCNF | All-key relation |
| `staff` | BCNF | |
| `venue` | BCNF | |
| `season` | BCNF | |
| `tournament` | 3NF | `entrants_count` is a controlled redundancy |
| `blind_level` | BCNF | |
| `payout_tier` | BCNF | |
| `registration` | BCNF | |
| `tournament_transaction` | BCNF | |
| `poker_table` | BCNF | |
| `seat_assignment` | BCNF | |
| `chip_count_log` | BCNF | |
| `hand` | BCNF | |
| `hand_player` | BCNF | |
| `hand_action` | BCNF | |
| `hand_summary` | BCNF | |
| `audit_log` | BCNF | |

The only deviation from BCNF is `tournament`, and it is deliberate:
`entrants_count` is derivable from `registration` but stored so that the
`CHECK (entrants_count <= max_entries)` constraint can exist at all. A
trigger keeps it correct, and test T19 verifies this.

---

## Part 3 — Referential actions

Each foreign key's `ON DELETE` behaviour was chosen deliberately rather
than left at the default.

| Child → Parent | Action | Reasoning |
|---|---|---|
| `blind_level → tournament` | `CASCADE` | A structure without its event is meaningless |
| `payout_tier → tournament` | `CASCADE` | Same |
| `poker_table → tournament` | `CASCADE` | Same |
| `player_phone → player` | `CASCADE` | Contact details of a deleted person |
| `registration → tournament` | `CASCADE` | Entries die with the event |
| `registration → player` | `RESTRICT` | **Refuses** to delete a player who has entry history; results must not silently vanish |
| `tournament → venue` | `RESTRICT` | A venue with history cannot be removed |
| `tournament → staff` | `SET NULL` | The event survives the director leaving |
| `player → app_user` | `SET NULL` | Revoking a login must not erase the competitor |
| `poker_table → staff` | `SET NULL` | A dealer leaving does not delete the table |
| `registration → registration` | `SET NULL` | Removing one entry must not cascade down the whole knockout chain |
| `hand_summary → hand` | `CASCADE` | **Keeps the vector store in step with the relational store** |
| `hand_player → hand` | `CASCADE` | |
| `hand_action → hand_player` | `CASCADE` | |

The contrast between `RESTRICT` on `registration → player` and `CASCADE` on
`registration → tournament` is the interesting one: deleting a *tournament*
should remove its entries, but deleting a *player* who has played must be
refused, because their results are part of other players' histories.

---

## Part 4 — Complete constraint inventory

**106 constraints: 19 primary keys, 25 foreign keys, 15 unique, 47 check.**

### Representative CHECK constraints

| Constraint | Rule |
|---|---|
| `ck_app_user_email_fmt` | E-mail is lowercase and matches a valid pattern |
| `ck_app_user_hash_len` | Hash is ≥ 20 chars — a plaintext password fails loudly |
| `ck_player_adult` | `date_of_birth <= CURRENT_DATE - INTERVAL '18 years'` |
| `ck_player_country` | ISO two-letter uppercase code |
| `ck_tournament_buyin` | `buy_in > 0` |
| `ck_tournament_rake` | `0 <= rake_pct < 50` |
| `ck_tournament_entrants` | `entrants_count <= max_entries` |
| `ck_blind_bb_gt_sb` | `big_blind >= small_blind` |
| `ck_payout_pct` | `0 < pct_of_pool <= 100` |
| `ck_reg_not_self_ko` | An entry cannot eliminate itself |
| `ck_reg_bust_consistency` | An active entry has no finish rank; a busted one must have one |
| `ck_hand_board` | Board matches `^([2-9TJQKA][shdc])( [2-9TJQKA][shdc]){2,4}$` |
| `ck_hp_hole` | Hole cards match a two-card pattern |
| `ck_action_passive` | A `FOLD` or `CHECK` carries zero chips |
| `ck_summary_len` | Narrative between 10 and 4000 characters |

### Partial unique indexes — rules a plain UNIQUE cannot express

```sql
-- one live occupant per physical seat
CREATE UNIQUE INDEX uq_seat_live_occupancy
    ON seat_assignment (table_id, seat_no) WHERE vacated_at IS NULL;

-- an entry cannot sit at two tables at once
CREATE UNIQUE INDEX uq_seat_live_entry
    ON seat_assignment (registration_id) WHERE vacated_at IS NULL;

-- at most one primary phone per player
CREATE UNIQUE INDEX uq_player_primary_phone
    ON player_phone (player_id) WHERE is_primary;
```

A plain `UNIQUE (table_id, seat_no)` would be wrong — it would forbid seat 3
at table 1 from ever being reused, destroying the seating history. The
`WHERE` clause restricts the rule to rows that represent *current*
occupancy, which is exactly the business rule.

---

## Part 5 — Rules that needed a trigger

A `CHECK` constraint can only see the row being written. These rules need
to consult another row or another table, which is precisely the gap
triggers exist to fill.

| Rule | Trigger | Why a constraint cannot do it |
|---|---|---|
| Seat number within the table's seat count | `tr_validate_seat` | `seat_no` is on `seat_assignment`, `max_seats` on `poker_table` |
| An entry may only sit in its own tournament | `tr_validate_seat` | Compares two different parents |
| An action belongs to a participant of the same hand | `tr_validate_action` | Two FKs can each be valid while pointing at unrelated rows |
| Field cannot be oversold | `tr_entrants_count` + `CHECK` | A `CHECK` cannot count rows elsewhere |
| Career earnings match results | `tr_sync_player_earnings` | Cross-table consistency |
| A paid entry cannot be deleted | `tr_protect_paid_entry` | Constraints do not fire on `DELETE` |
| Audit log is append-only | `tr_audit_immutable` | Needs to reject an operation outright |
| Chips balance within a hand | `sp_record_hand` | Needs all participant rows together, so it lives in the procedure |
