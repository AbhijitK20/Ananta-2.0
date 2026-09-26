# 03 — Marketplace & Booking-Loop Extraction for ATHITI

Repos: `domain/pretix`, `patterns/medusa`, `adopt/better-auth`, `adopt/drizzle-orm`,
`domain/rox`, `domain/trustroots`, `systems/ai-tour-meeting`

Every claim is tagged `repo/path:line`. Snippets are verbatim unless marked INFERENCE.

---

## 0. Executive summary (read this first)

pretix does **not** store a "remaining capacity" counter. Capacity is **derived by
aggregation** at read time (`domain/pretix/src/pretix/base/services/quotas.py:226-500`).
Oversell is prevented by **Postgres advisory locks held for the duration of a DB
transaction** (`domain/pretix/src/pretix/base/services/locking.py:100-122`), *not* by a
DB constraint and *not* by optimistic concurrency. This is the single most important
finding: the lock is on the *Quota* row, and the availability sum is recomputed
*after* acquiring the lock.

For ATHITI this collapses to one decision — see §10.

---

## 1. Availability + capacity data model (pretix)

### 1.1 The core idea: capacity is a *derived aggregate*, not a column

`Quota.size` is the only stored capacity number
(`domain/pretix/src/pretix/base/models/items.py:2068-2072`):

```python
size = models.PositiveIntegerField(
    verbose_name=_("Total capacity"),
    null=True, blank=True,
    help_text=_("Leave empty for an unlimited number of tickets.")
)
items = models.ManyToManyField(Item, related_name="quotas", blank=True)
variations = models.ManyToManyField(ItemVariation, related_name="quotas", blank=True,
    verbose_name=_("Variations"))
```

There is **no** `remaining` / `sold` / `reserved` column. Availability is computed by
subtracting five separate counts from `size` — `domain/pretix/src/pretix/base/services/quotas.py:242`:

```python
size_left = Counter({q: (sys.maxsize if s is None else s) for q, s in self.sizes.items()})
```

then, in strict priority order, each of these *decrements* `size_left`:

| Order | Source | Method | Line | Terminal state if it hits 0 |
|---|---|---|---|---|
| 1 | `OrderPosition` with `order__status IN (PAID, PENDING)` | `_compute_orders` | `quotas.py:297-371` | `AVAILABILITY_GONE` (paid) / `AVAILABILITY_ORDERED` (pending) |
| 2 | `Voucher` un-redeemed budget (`block_quota=True`, not expired) | `_compute_vouchers` | `quotas.py:373-418` | `AVAILABILITY_ORDERED` |
| 3 | `CartPosition` in an unexpired cart | `_compute_carts` | `quotas.py:420-455` | `AVAILABILITY_RESERVED` |
| 4 | `WaitingListEntry` | `_compute_waitinglist` | `quotas.py:457-491` | `AVAILABILITY_ORDERED` |

The "sold out" computation is literally — `quotas.py:290-295`:

```python
for q in quotas:
    if q not in self.results:
        if size_left[q] > 0:
            self.results[q] = Quota.AVAILABILITY_OK, size_left[q]
        else:
            raise ValueError("inconclusive quota")
```

**So: capacity is NOT decremented eagerly. It is re-aggregated from the order/cart
rows every time it is asked for.** Cancellations and expiries therefore "give capacity
back" for free — there is no counter to reconcile. That is a genuinely clever property
and it is directly copyable.

### 1.2 The four availability states (a real enum, worth copying)

`domain/pretix/src/pretix/base/models/items.py:2046-2049`:

```python
AVAILABILITY_GONE = 0        # completely sold out
AVAILABILITY_ORDERED = 10    # all remaining units are in unpaid orders
AVAILABILITY_RESERVED = 20   # all remaining units are in people's carts
AVAILABILITY_OK = 100        # available
```

The ordering is meaningful (`GONE < ORDERED < RESERVED < OK`) and is used as a
"better than" comparison for cache writes — see §1.5. Documented at
`items.py:2005-2022`.

### 1.3 Early-outs (no DB access needed)

`domain/pretix/src/pretix/base/services/quotas.py:493-500`:

```python
def _compute_early_outs(self, quotas):
    for q in quotas:
        if q.closed and not self._ignore_closed:
            self.results[q] = Quota.AVAILABILITY_ORDERED, 0
        elif q.size is None:
            self.results[q] = Quota.AVAILABILITY_OK, None
        elif q.size == 0:
            self.results[q] = Quota.AVAILABILITY_GONE, 0
```

### 1.4 The Quota model — full field list (this is our "capacity pool")

`domain/pretix/src/pretix/base/models/items.py:1988-2118`. Docstring `items.py:1989-2003`
describes it as "a pool of tickets … a quota of 500 applied to all of your items
(because you only have that much space in your venue), and also a quota of 100 applied
to the VIP tickets".

| Field | Type | Line | Meaning |
|---|---|---|---|
| `event` | FK Event | 2051 | owning event |
| `subevent` | FK SubEvent, nullable | 2057 | **the date/time window** — quotas are per-date |
| `name` | char(200) | 2064 | |
| `size` | PositiveInteger, **nullable** | 2068 | `NULL` = unlimited |
| `items` | M2M Item | 2073 | which products this pool covers |
| `variations` | M2M ItemVariation | 2079 | |
| `ignore_for_event_availability` | bool | 2086 | merchandise shouldn't mark the event sold out |
| `close_when_sold_out` | bool | 2094 | once gone, stay gone even if cancellations free capacity |
| `closed` | bool | 2101 | manual kill switch |
| `release_after_exit` | bool | 2103 | free capacity when people are *checked out*, not just checked in |
| `cached_availability` / `cached_availability_paid_orders` | (properties) | 2035-2043 | **denormalised cache, explicitly documented as possibly stale** |

`close_when_sold_out` is applied in `quotas.py:219-224`:

```python
def _close(self, quotas):
    for q in quotas:
        if self.results[q][0] <= Quota.AVAILABILITY_ORDERED and q.close_when_sold_out and not q.closed:
            q.closed = True
            q.save(update_fields=['closed'])
            q.log_action('pretix.event.quota.closed')
```

### 1.5 The availability cache — do NOT copy this for a hackathon

`domain/pretix/src/pretix/base/services/quotas.py:135-157` (read), `175-212` (write).
Redis hash `quotas:{event_id}:availabilitycache`, entries valid **120 s**, written
behind a naive 10-second `SET … ex=10` lock to avoid a thundering herd. The model
docstring is refreshingly honest about why (`items.py:2035-2043`):

> This model keeps a cache of the quota availability that is used in places where
> up-to-date data is not important. This cache might be out of date even though a
> more recent quota was calculated. This is intentional to keep database writes low.

**ATHITI verdict: skip the cache entirely.** At hackathon scale a single indexed
aggregate over `booking_request` is sub-millisecond.

### 1.6 Date-time windows — three nested layers

pretix has **three independent window layers**, and a listing must satisfy *all* of
them. This is the most directly copyable idea for ATHITI.

**Layer 1 — event level** (`domain/pretix/src/pretix/base/models/event.py:634-651`):

```python
date_from = models.DateTimeField(verbose_name=_("Event start time"))
date_to = models.DateTimeField(null=True, blank=True, …)          # nullable!
presale_end = models.DateTimeField(…)      # No tickets will be sold after this date.
presale_start = models.DateTimeField(…)    # No tickets will be sold before this date.
is_public = models.BooleanField(default=True, …)
live = models.BooleanField(default=False, verbose_name=_("Shop is live"))
```

**Layer 2 — sub-event (series date) level.** `presale_start`/`presale_end` can be
overridden per date, and are *clamped* against the parent — `event.py:246-256` and
`event.py:286-296`:

```python
@property
def effective_presale_end(self):
    if isinstance(self, SubEvent):
        presale_ends = [self.presale_end, self.event.presale_end]
        return min(filter(lambda x: x is not None, presale_ends)) if any(presale_ends) else None
    else:
        return self.presale_end
```

(`effective_presale_start` uses `max()` — `event.py:287-296`. This clamp-the-child-
window-inside-the-parent-window pattern is worth stealing.)

**Layer 3 — product level** (`domain/pretix/src/pretix/base/models/items.py:565-584`):

```python
available_from = models.DateTimeField(null=True, blank=True,
    help_text=_('This product will not be sold before the given date.'))
available_from_mode = models.CharField(choices=UNAVAIL_MODES,
    default=UNAVAIL_MODE_HIDDEN, max_length=16)
available_until = models.DateTimeField(null=True, blank=True,
    help_text=_('This product will not be sold after the given date.'))
available_until_mode = models.CharField(choices=UNAVAIL_MODES,
    default=UNAVAIL_MODE_HIDDEN, max_length=16)
```

Note the `_mode` companion field: a closed window can be either *hidden* or *shown as
informational* (greyed out, with a reason). The availability query
(`items.py:317-324`) honours this:

```python
q = (
    Q(active=True)
    & Q(Q(available_from__isnull=True) | Q(available_from__lte=time_machine_now()) | Q(available_from_mode='info'))
    & Q(Q(available_until__isnull=True) | Q(available_until__gte=time_machine_now()) | Q(available_until_mode='info'))
    & Q(require_bundling=False)
)
```

**ATHITI translation:** `listing.starts_at` / `listing.ends_at` (the experience happens)
+ `listing.book_from` / `listing.book_until` (when it can be requested) + `slot.starts_at`
per dated occurrence. Do **not** build the 3-layer clamp for a hackathon — 2 layers
(occurrence + booking window) is enough.

### 1.7 Per-listing booking rules (all on `Item`, all copyable)

`domain/pretix/src/pretix/base/models/items.py:613-666`:

| Field | Line | ATHITI equivalent |
|---|---|---|
| `require_voucher` | 613 | invite-only listing |
| `require_approval` | 619 | **"requests need provider approval" — this IS our booking-request model** |
| `hide_without_voucher` | 626 | listing hidden until code entered |
| `require_bundling` | 632 | only sellable as part of a bundle |
| `allow_cancel` | 639 | can the traveller cancel? |
| `min_per_order` | 645 | min party size |
| `max_per_order` | 652 | max party size |

`require_approval`'s help text (`items.py:622-624`) is the clearest statement of
pretix's approval model in the whole codebase:

> If this option is set, the product will be part of an order, the order will be put
> into an "approval" state and will need to be confirmed by you before it can be paid
> and completed.

`require_approval` is **copied onto the Order at creation** —
`domain/pretix/src/pretix/base/models/orders.py:310-312`:

```python
require_approval = models.BooleanField(
    default=False
)
```

…and it *suppresses* the paid-until-time machinery — `orders.py:354`, `orders.py:607`:

```python
self.__initial_status_paid_or_pending = self.status in (Order.STATUS_PENDING, Order.STATUS_PAID) and not self.require_approval
```

### 1.8 Order states — the real enum

`domain/pretix/src/pretix/base/models/orders.py:196-206`:

```python
STATUS_PENDING = "n"
STATUS_PAID = "p"
STATUS_EXPIRED = "e"
STATUS_CANCELED = "c"
STATUS_REFUNDED = "c"  # deprecated
STATUS_CHOICE = (
    (STATUS_PENDING, _("pending")),
    (STATUS_PAID, _("paid")),
    (STATUS_EXPIRED, _("expired")),
    (STATUS_CANCELED, _("canceled")),
)
```

Only **four** states. Note: there is **no `rejected`** state — a declined order is
`EXPIRED` and a cancelled one is `CANCELED`; both are excluded from quota counting
identically (`quotas.py:305` only counts `PAID`/`PENDING`). ATHITI needs more states
than this; see §9.

Supporting fields on `Order` (`orders.py:196-320`):
`code` (short human-quotable, unique-per-event), `secret` (32-char, for the
self-service link), `expires` (DateTimeField — the hold expires here),
`valid_if_pending` (bool — "treat like paid for check-in"),
`require_approval` (bool — orthogonal to `status`), `last_modified` (auto_now,
optimistic-concurrency guard, see §2.4).

### 1.9 The cart — holds capacity too

`domain/pretix/src/pretix/base/models/orders.py:3215-3245`. The docstring is the
design rationale, and it is exactly the rationale for a "shopping cart" in ATHITI:

```python
class CartPosition(AbstractPosition):
    """
    A cart position is similar to an order line, except that it is not
    yet part of a binding order but just placed by some user in his or
    her cart. It therefore normally has a much shorter expiration time
    than an ordered position, but still blocks an item in the quota pool
    as we do not want to throw out users while they're clicking through
    the checkout process.
    """
    cart_id = models.CharField(max_length=255, null=True, blank=True, db_index=True,
        verbose_name=_("Cart ID (e.g. session key)"))
    expires = models.DateTimeField(verbose_name=_("Expiration date"), db_index=True)
    max_extend = models.DateTimeField(verbose_name=_("Limit for extending expiration date"), null=True)
```

**This is a genuinely important product decision, not just an implementation detail.**
pretix holds capacity for the whole checkout. For ATHITI that means: a traveller who
clicks "Request" and then abandons should not free the slot instantly, or a provider
gets double-booked.

---

## 2. Oversell prevention — the most important section

### 2.1 It is a Postgres advisory lock, xact-scoped

`domain/pretix/src/pretix/base/services/locking.py:75-122`. The whole primitive:

```python
def lock_objects(objects, *, shared_lock_objects=None, replace_exclusive_with_shared_when_exclusive_are_more_than=20):
    """
    Create an exclusive lock on the objects passed in `objects`. This function MUST be called within an atomic
    transaction and SHOULD be called only once per transaction to prevent deadlocks.
    …
    The idea behind it is this: Usually we create a lock on every quota, voucher, or seat contained in an order.
    However, this has a large performance penalty in case we have hundreds of locks required. Therefore, we always
    place a shared lock in the event, and if we have too many affected objects, we fall back to event-level locks.
    """
    if (not objects and not shared_lock_objects) or 'skip-locking' in debugflags_var.get():
        return
    …
    if not connection.in_atomic_block:
        raise RuntimeError("You cannot create locks outside of an transaction")

    if 'postgresql' in settings.DATABASES['default']['ENGINE']:
        shared_keys = set(pg_lock_key(obj) for obj in shared_lock_objects) if shared_lock_objects else set()
        exclusive_keys = set(pg_lock_key(obj) for obj in objects)
        …
        keys = sorted(list(shared_keys | exclusive_keys))
        calls = ", ".join([
            (f"pg_advisory_xact_lock({k})" if k in exclusive_keys else f"pg_advisory_xact_lock_shared({k})") for k in keys
        ])

        try:
            with connection.cursor() as cursor:
                cursor.execute(f"SET LOCAL lock_timeout = '{LOCK_ACQUISITION_TIMEOUT}s';")
                cursor.execute(f"SELECT {calls};")
                cursor.execute("SET LOCAL lock_timeout = '0';")  # back to default
        except DatabaseError as e:
            logger.warning(f"Waiting for locks timed out: {e} on SELECT {calls};")
            raise LockTimeoutException()

    else:
        for model, instances in groupby(objects, key=lambda o: type(o)):
            model.objects.select_for_update().filter(pk__in=[o.pk for o in instances])
```

Key facts:
- **Postgres path**: `pg_advisory_xact_lock` / `pg_advisory_xact_lock_shared` — released
  automatically at COMMIT/ROLLBACK. No lock table, no row contention, no deadlock
  between *different* quota rows.
- **Fallback path (MySQL/SQLite)**: plain `select_for_update()` on the quota row.
- `LOCK_ACQUISITION_TIMEOUT = 3` seconds (`locking.py:36`) → `LockTimeoutException`,
  which the caller turns into a retry, not an error.
- A `shared` lock is *always* taken on the `Event` (`KEY_SPACES` at `locking.py:46-52`
  puts Event=1, Quota=2, Seat=3, Voucher=4, Membership=5 in separate key spaces).
- The key is a hand-packed bigint (`locking.py:55-68`) that deliberately folds 5 tables
  into one 64-bit space:

```python
def pg_lock_key(obj):
    """
    This maps the primary key space of multiple tables to a single bigint key space within postgres. It is not
    an injective function, which is fine, as long as collisions are rare.
    """
    keyspace = KEY_SPACES.get(type(obj))
    objectid = obj.pk
    if not keyspace:
        raise ValueError(f"No key space defined for locking objects of type {type(obj)}")
    assert isinstance(objectid, int)
    # 64bit int: xxxxxxxx xxxxxxx xxxxxxx xxxxxxx xxxxxx xxxxxxx xxxxxxx xxxxxxx
    #            |              objectid mod 2**48             | |index| |keysp.|
    key = ((objectid % 281474976710656) << 16) | ((settings.DATABASE_ADVISORY_LOCK_INDEX % 256) << 8) | (keyspace % 256)
    return key
```

The comment "**It is not an injective function, which is fine, as long as collisions are
rare**" is worth internalising: false sharing between unrelated objects is accepted
because it only costs a little concurrency.

### 2.2 The critical ordering: lock FIRST, then re-count

`domain/pretix/src/pretix/base/services/orders.py:776-799` — the order-creation path
takes the lock *before* checking availability:

```python
# Create locks
sorted_positions = [cp for cp in sorted_positions if cp.pk and cp.pk not in deleted_positions]  # eliminate deleted
if any(cp.expires < now() + timedelta(seconds=LOCK_TRUST_WINDOW) for cp in sorted_positions):
    # No need to perform any locking if the cart positions still guarantee everything long enough.
    full_lock_required = any(
        getattr(o, 'seat', False) for o in sorted_positions
    ) and event.settings.seating_minimal_distance > 0
    if full_lock_required:
        # We lock the entire event in this case since we don't want to deal with fine-granular locking
        # in the case of seating distance enforcement
        lock_objects([self.event])
    else:
        lock_objects(
            [q for q in reduce(operator.or_, (set(cp._cached_quotas) for cp in sorted_positions), set()) if q.size is not None] +
            [op.voucher for op in sorted_positions if op.voucher] +
            [op.seat for op in sorted_positions if op.seat],
            shared_lock_objects=[event]
        )
```

Then the check itself — `domain/pretix/src/pretix/base/models/orders.py:1109-1128`:

```python
quotas = op._cached_quotas
if len(quotas) == 0:
    raise Quota.QuotaExceededException(error_messages['unavailable'].format(...))

for quota in quotas:
    if quota.id not in quota_cache:
        quota_cache[quota.id] = quota
        quota.cached_availability = quota.availability(now_dt, count_waitinglist=count_waitinglist)[1]
    else:
        # Use cached version
        quota = quota_cache[quota.id]
    if quota.cached_availability is not None:
        quota.cached_availability -= 1
        if quota.cached_availability < 0:
            # This quota is sold out/currently unavailable, so do not sell this at all
            raise Quota.QuotaExceededException(error_messages['unavailable'].format(
                item=str(op.item) + (' - ' + str(op.variation) if op.variation else '')
            ))
```

**This is the answer to "is capacity decremented eagerly or checked at checkout?"**
Checked at checkout, under an advisory lock, by re-running the aggregate. The lock is
acquired, *then* `quota.availability()` re-reads the live order rows, *then* the local
counter is decremented per line. Two concurrent buyers for the last slot serialise on
the Quota advisory lock; the second one sees the first one's committed `Order` and is
rejected.

### 2.3 The `LOCK_TRUST_WINDOW` optimisation — and its documented risk

`domain/pretix/src/pretix/base/services/locking.py:38-43`:

```python
# We make the assumption that it is safe to e.g. transform an order into a cart if the order has a lifetime of more than
# LOCK_TRUST_WINDOW into the future. In other words, we assume that a lock is never held longer than LOCK_TRUST_WINDOW.
# This assumption holds true for all in-request locks, since our gunicorn default settings kill a worker that takes
# longer than 60 seconds to process a request. It however does not hold true for celery tasks, especially long-running
# ones, so this does introduce *some* risk of incorrect locking.
LOCK_TRUST_WINDOW = 120
```

So: **if a cart position's own expiry is >120 s away, pretix skips the lock entirely**
(`orders.py:778`) and trusts the cart's hold. Elegant, and a real risk that pretix
documents rather than hides. Don't copy this for a hackathon; always lock.

### 2.4 Optimistic concurrency *as well*, for order-row edits

pretix also uses `select_for_update` + a `last_modified` comparison to detect
concurrent edits to the *same order* — `domain/pretix/src/pretix/base/services/orders.py:3136-3139`:

```python
with transaction.atomic():
    locked_instance = Order.objects.select_for_update(of=OF_SELF).get(pk=self.order.pk)
    if locked_instance.last_modified != self.order.last_modified:
        raise OrderError(error_messages['race_condition'])
```

And the same pattern in `base/models/base.py:236-248` ("Like `refresh_from_db()`, but
with `select_for_update()`"). So pretix uses **both** mechanisms, for different
resources: advisory locks for *shared scarce resources* (quota/seat/voucher),
`select_for_update` + version check for *single-owner rows* (order).

### 2.5 Lock-timeout is a retry, not a failure

`domain/pretix/src/pretix/base/services/orders.py:3214-3227`:

```python
@app.task(base=ProfiledEventTask, bind=True, max_retries=5, default_retry_delay=1, throws=(OrderError,))
def perform_order(self, event: Event, payments: List[dict], positions: List[str], …):
    with language(locale), time_machine_now_assigned(override_now_dt):
        try:
            try:
                return _perform_order(event, payments, positions, email, locale, address, meta_info,
                                      sales_channel, shown_total, customer, api_meta, cart_id=cart_id)
            except LockTimeoutException:
                self.retry()
        except (MaxRetriesExceededError, LockTimeoutException):
            raise OrderError(error_messages['busy'])
```

Contention surfaces to the user as **"we're busy, try again"** after ≤5 retries.
This is a good demo story: you can show a second concurrent request getting a clean
`409 / busy` rather than an oversell.

### 2.6 A "dirty transaction" tripwire

`domain/pretix/src/pretix/base/models/_transactions.py:23-26, 96-101` — a module that
actively *raises* if you mutate an order outside a transaction:

```python
"""
This module contains helper functions that are supposed to call out code paths missing calls to
``Order.create_transaction()`` by actively breaking them. …
"""
…
if not conn.in_atomic_block:
    _fail(
        "You modified an Order, OrderPosition, or OrderFee object in a way that should create "
        "a new Transaction object within the same database transaction, however you are not "
        "doing it inside a database transaction!"
    )
```

Cheap idea, good to copy: a dev-only assertion that catches capacity mutations made
outside a transaction.

### 2.7 What it is NOT

- **Not a DB-level constraint.** No `CHECK (sold <= size)`, no exclusion constraint, no
  serializable-isolation retry loop. The only DB constraint is PK/FK/unique.
- **Not optimistic** on capacity (it is optimistic on the order *row*, §2.4).
- **Not a counter.** Confirmed by reading every field of `Quota` (`items.py:1988-2118`).

---

## 3. Organiser (backend) vs buyer (presale) split

### 3.1 The actual app split in this checkout

The sparse-checkout lists `src/pretix/eventbox/`
(`.git/info/sparse-checkout`), but **`eventbox` does not exist in this commit**:

```
$ git ls-tree -r --name-only HEAD -- src/pretix/eventbox/
(no output)
$ git ls-tree -d HEAD src/pretix/
… src/pretix/control   ← the organiser backend, in its place
```

So in this pretix version the organiser backend is **`src/pretix/control/`** and the
buyer frontend is **`src/pretix/presale/`**. Files below are read via `git show
HEAD:…` (read-only).

### 3.2 What each side owns

| | `presale/` (buyer) | `control/` (organiser) |
|---|---|---|
| Size | 8467 lines of views | 33 views + 25 forms |
| Cart | `views/cart.py` (875) | — |
| Checkout | `views/checkout.py`, `checkoutflow.py` (~1750 lines) | — |
| Order self-service | `views/order.py` (1809) — pay, cancel, change, download ticket | `views/orders.py` — search, refund, mark paid |
| Waiting list | `views/waiting.py` (230) | `views/waitinglist` + `forms/waitinglist.py` |
| Event listing | `views/event.py` (631) | `views/event.py`, `views/subevents.py` |
| Vouchers | redeem only | `views/vouchers.py`, `forms/vouchers.py`, `forms/discounts.py` |
| Products & quotas | — | `views/item.py`, `forms/item.py` |
| Dashboards | — | `views/dashboards.py` |
| Auth | `views/user.py`, `customersso/`, `views/oidc_op.py` (OIDC provider, 568) | `views/users.py`, `views/auth.py`, `views/oauth.py` |
| Data sync / shredder | — | `views/datasync.py`, `views/shredder.py` |
| Check-in | — | `views/checkin.py` |

Buyer routes are all under the event slug, and orders are addressed by
`order code + secret` — `src/pretix/presale/urls.py:106-143`:

```python
re_path(r'^order/(?P<order>[^/]+)/(?P<secret>[A-Za-z0-9]+)/$', … name='event.order'),
re_path(r'^order/(?P<order>[^/]+)/(?P<secret>[A-Za-z0-9]+)/invoice$', …),
re_path(r'^order/(?P<order>[^/]+)/(?P<secret>[A-Za-z0-9]+)/change$', …),
re_path(r'^order/(?P<order>[^/]+)/(?P<secret>[A-Za-z0-9]+)/cancel$', …),
re_path(r'^order/(?P<order>[^/]+)/(?P<secret>[A-Za-z0-9]+)/pay/(?P<payment>[0-9]+)/$', …),
```

**ATHITI takeaway:** the buyer side needs *no* account to view an order — a code +
secret in the URL. That is the cheapest possible provider-side demo, and it means
better-auth is only strictly required for the *provider* side.

### 3.3 The organiser's checkout-flow definition (a step engine, in Python)

pretix has its own workflow/step system, and it is directly relevant to §4. Steps are
a priority-sorted doubly-linked list — `src/pretix/presale/checkoutflow.py:1753-1760`:

```python
DEFAULT_FLOW = (
    AddOnsStep,
    CustomerStep,
    MembershipStep,
    QuestionsStep,
    PaymentStep,
    ConfirmStep
)
```

Each step declares `priority`, `identifier`, `template_name`, `label`, `icon`, and
optionally `task` (a celery task) and `requires_valid_cart` —
`checkoutflow.py:486-494`, `checkoutflow.py:1304-1309`, `checkoutflow.py:1577-1584`:

```python
class ConfirmStep(CartMixin, AsyncAction, TemplateFlowStep):
    priority = 1001
    identifier = "confirm"
    template_name = "pretixpresale/event/checkout_confirm.html"
    task = perform_order
    known_errortypes = ['OrderError']
    label = pgettext_lazy('checkoutflow', 'Review order')
    icon = 'eye'
```

Priorities: `AddOnsStep` 40, `CustomerStep` 45, `MembershipStep` 47, `QuestionsStep` 50,
`PaymentStep` 200, `ConfirmStep` 1001. Plugins may inject steps (capped at priority
≤1000 so they can't preempt confirm) — `checkoutflow.py:195-213`:

```python
def get_checkout_flow(event):
    flow = list([step(event) for step in DEFAULT_FLOW])
    for receiver, response in checkout_flow_steps.send(event):
        step = response(event=event)
        if step.priority > 1000:
            raise ValueError('Plugins are not allowed to define a priority greater than 1000')
        flow.append(step)
    flow.sort(key=lambda p: p.priority)
    # Create a double-linked-list for easy forwards/backwards traversal
    last = None
    for step in flow:
        step._previous = last
        if last:
            last._next = step
        last = step
    return flow
```

Each step implements `is_applicable(request)`, `is_completed(request)`,
`requires_valid_cart`, `get_step_url`. The dispatcher walks the list and hard-redirects
past incomplete steps — `src/pretix/presale/views/checkout.py:69-92`:

```python
for step in flow:
    if not step.is_applicable(request):
        …
    if step.requires_valid_cart and cart_error:
        …
    if 'step' not in kwargs:
        …
    is_selected = (step.identifier == kwargs.get('step', ''))
    if "async_id" not in request.GET and not is_selected and not step.is_completed(request, warn=not is_selected):
        return self.redirect(step.get_step_url(request))
```

**This "a step is a state; you're redirected to the first incomplete one" pattern is
directly liftable for our booking state machine** and is a much lighter alternative to
Medusa's engine. See §9.

### 3.4 What a listing looks like — the organiser product editor

`ItemCreateForm` (`src/pretix/control/forms/item.py:442`) is a short wizard —
`forms/item.py:664-676`:

```python
class Meta:
    model = Item
    localized_fields = '__all__'
    fields = [
        'name', 'internal_name', 'category', 'admission',
        'personalized', 'default_price', 'tax_rule',
    ]
```

`ItemUpdateForm` is the full editor — `forms/item.py:894-935+`:

```python
fields = [
    'category', 'name', 'internal_name', 'active',
    'all_sales_channels', 'limit_sales_channels',
    'admission', 'personalized', 'description', 'picture',
    'default_price', 'free_price', 'free_price_suggestion', 'tax_rule',
    'available_from', 'available_from_mode',
    'available_until', 'available_until_mode',
    'require_voucher', 'require_approval', 'hide_without_voucher',
    'allow_cancel', 'allow_waitinglist',
    'max_per_order', 'min_per_order',
    'checkin_attention', 'checkin_text', 'generate_tickets',
    'original_price', 'require_bundling', 'show_quota_left',
    'hidden_if_available', 'hidden_if_item_available',
    'hidden_if_item_available_mode', 'issue_giftcard',
    'require_membership', 'require_membership_types', 'require_membership_hidden',
]
```

`QuotaForm` is the capacity editor — `src/pretix/control/forms/item.py:349-364`:

```python
class Meta:
    model = Quota
    localized_fields = '__all__'
    fields = [
        'name', 'size', 'subevent',
        'close_when_sold_out', 'release_after_exit',
        'ignore_for_event_availability',
    ]
    widgets = {
        'size': forms.NumberInput(attrs={'placeholder': _('Unlimited')})
    }
```

…with a `QuotaBulkEditForm` for multi-select edits (`forms/item.py:388`).

**ATHITI provider listing editor, distilled to the fields that matter:**

| Group | Fields |
|---|---|
| Identity | `title`, `slug`, `description`, `photos[]`, `category` |
| Who & where | `provider_id`, `location_id`, `address`, `geo` |
| When | `book_from`, `book_until`; occurrences: `starts_at`, `ends_at` |
| Capacity | `capacity` (nullable = unlimited), `min_party`, `max_party` |
| Policy | `requires_approval` (bool), `allow_cancellation` (bool), `cancellation_deadline_hours` |
| Pricing | `price_cents`, `currency` (skip deposits) |
| Visibility | `active` (draft/live), `is_public` |
| Vouchers | *cut for v1* |

That is ~14 fields. pretix needs 40+ because it does invoicing, tax rules, check-in,
memberships and PDF tickets.

---

## 4. Medusa's workflow / step engine

### 4.1 Vocabulary: workflow vs step

- A **step** = one unit of work with an `invoke` and an optional `compensate`.
  Created *outside* a workflow; it returns a `WorkflowData` proxy, not a value.
- A **workflow** = a named, ordered DAG of steps with persisted execution state.
- Crucially, the composer function body **does not execute** — it *declares* the graph.
  Steps return a proxy object carrying `__type` + `__step__`
  (`packages/core/workflows-sdk/src/utils/composer/create-step.ts:194-197`):

```typescript
const ret = {
  __type: OrchestrationUtils.SymbolWorkflowStep,
  __step__: stepName,
}
```

The comment at `create-step.ts:90-96` (from the JSDoc example) states the design goal:
"Everything here will be executed and resolved later during the execution. Including
the data access." That is a *big* idea — **the workflow body can reference not-yet-created
entities**, because it is a plan, not code that runs.

### 4.2 `createStep` — the exact signature

`packages/core/workflows-sdk/src/utils/composer/create-step.ts:434-467`:

```typescript
export function createStep<
  TInvokeInput,
  TInvokeResultOutput,
  TInvokeResultCompensateInput
>(
  nameOrConfig: string | ({ name: string } & Omit<TransactionStepsDefinition, "next" | "uuid" | "action">),
  invokeFn: InvokeFn<TInvokeInput, TInvokeResultOutput, TInvokeResultCompensateInput>,
  compensateFn?: CompensateFn<TInvokeResultCompensateInput>
): StepFunction<TInvokeInput, TInvokeResultOutput> {
```

`InvokeFn` — `create-step.ts:35-53`:

```typescript
export type InvokeFn<TInput, TOutput, TCompensateInput> = (
  input: TInput,
  context: StepExecutionContext
) =>
  | void
  | StepResponse<TOutput, TCompensateInput extends undefined ? TOutput : TCompensateInput>
  | Promise<void | StepResponse<…>>
```

`CompensateFn` — `create-step.ts:63-72`:

```typescript
export type CompensateFn<T> = (
  input: T | undefined,
  context: StepExecutionContext
) => unknown | Promise<unknown>
```

Registration into the flow, including the ULID step identity and the
"no compensation function ⇒ this step is not compensated" rule —
`create-step.ts:183-192`:

```typescript
stepConfig.uuid = ulid()
stepConfig.noCompensation = !compensateFn

this.flow.addAction(stepName, stepConfig)

this.isAsync ||= !!(stepConfig.async || stepConfig.compensateAsync)

this.overriddenHandler.set(stepName, this.handlers.get(stepName)!)
this.handlers.set(stepName, handler)
```

### 4.3 `StepResponse` — output + the *compensate input*

`packages/core/workflows-sdk/src/utils/composer/helpers/step-response.ts:28-44`:

```typescript
constructor(output?: TOutput, compensateInput?: TCompensateInput) {
  if (isDefined(output)) { this.#output = output }
  this.#compensateInput = (isDefined(compensateInput) ? compensateInput : output) as TCompensateInput
}
```

The key trick: **the compensate function receives a separately-declared
`compensateInput`, not the full output.** So a step that returns a fat ORM object can
hand its compensation just `{ bookingId }`. Documented at `create-step.ts:449-451` and
`step-response.ts:33-35`.

Two static escape hatches — `step-response.ts:120-132`:

```typescript
static permanentFailure(message = "Permanent failure", compensateInput?: unknown): never {
  const response = isDefined(compensateInput) ? new StepResponse(compensateInput) : undefined
  throw new PermanentStepFailureError(message, response)
}

static skip(): SkipStepResponse {
  return new SkipStepResponse()
}
```

So a step can distinguish **"retry me"** (throw) from **"don't retry, compensate now"**
(`permanentFailure`) from **"skip me"** (`skip`). That is precisely the distinction we
need for "capacity gone" vs "provider said no".

### 4.4 Per-step config: retry, timeout, async, failure policy

`packages/core/orchestration/src/transaction/types.ts:13-125` — abridged to the fields
that matter, with line numbers:

| Field | Line | Default | Meaning |
|---|---|---|---|
| `noCompensation?: boolean` | 42 | set from `!compensateFn` | skip rollback for this step |
| `maxRetries?: number` | 48 | **0** | retries on *temporary* failure |
| `autoRetry?: boolean` | 54 | true | |
| `retryInterval?: number` | 60 | immediate | seconds |
| `retryIntervalAwaiting?: number` | 65 | | re-poll a `WAITING` step |
| `maxAwaitingRetries?: number` | 70 | | |
| `timeout?: number` | 77 | none | → `TransactionStepState.TIMEOUT` |
| `async?: boolean` | 84 | false | don't block the workflow |
| `nested?: boolean` | 89 | | sub-transaction |
| `backgroundExecution?: boolean` | 95 | | fire-and-forget |
| `compensateAsync?: boolean` | 100 | | |
| `noWait?: boolean` | 105 | | don't wait for siblings |
| `saveResponse?: boolean` | 111 | true | put output in shared context |
| `continueOnPermanentFailure?: boolean` | 30 | | keep going after hard failure |
| `skipOnPermanentFailure?: boolean \| string` | 37 | | skip rest / jump to a named step |
| `next?: TransactionStepsDefinition \| TransactionStepsDefinition[]` | 116 | | fan-out |

Note `maxRetries` **defaults to 0**. A step that can fail transiently must opt in.

### 4.5 Workflow-level options — including idempotency

`packages/core/orchestration/src/transaction/types.ts:130-168`:

```typescript
export type TransactionModelOptions = {
  timeout?: number
  /**
   * If true, the state of the transaction will be persisted.
   */
  store?: boolean
  retentionTime?: number
  storeExecution?: boolean      // @deprecated no longer needed
  /**
   * If true, the workflow will use the transaction ID as the key to ensure only-once execution
   */
  idempotent?: boolean
  schedule?: string | SchedulerOptions
}
```

**`idempotent` is the only named "exactly-once" mechanism**, and the docstring tells you
precisely how it works: the transaction id is the dedup key.

Storage is *implied* by need, not configured blindly —
`packages/core/orchestration/src/transaction/transaction-orchestrator.ts:1519-1528`:

```typescript
if (
  hasStepTimeouts ||
  hasRetriesTimeout ||
  hasTransactionTimeout ||
  isIdempotent ||
  this.options.retentionTime ||
  hasAsyncSteps
) {
  this.options.store = true
}
```

### 4.6 The idempotency mechanism, in code

`packages/core/orchestration/src/transaction/transaction-orchestrator.ts:1737-1765`:

```typescript
const existingTransaction =
  await TransactionOrchestrator.loadTransactionById(this.id, transactionId)

let newTransaction = false
let modelFlow: TransactionFlow
if (!existingTransaction) {
  modelFlow = this.createTransactionFlow(transactionId, flowMetadata, context)
  newTransaction = true
} else {
  modelFlow = existingTransaction.flow
}

const transaction = new DistributedTransaction(
  modelFlow, handler, payload,
  existingTransaction?.errors, existingTransaction?.context
)

if (newTransaction && this.getOptions().store) {
  await transaction.saveCheckpoint({ ttl: modelFlow.hasAsyncSteps ? 0 : TransactionOrchestrator.DEFAULT_TTL })
}
```

So idempotency = **"load the checkpoint for this transaction id; if it exists, resume
it (already-`DONE` steps are skipped) instead of building a new flow."** The caller
supplies a *deterministic* transaction id. The nested-step id derives from it —
`packages/core/workflows-sdk/src/utils/composer/create-workflow.ts:35-46`:

```typescript
const buildTransactionId = (step: { __step__: string }, stepContext: StepExecutionContext) => {
  return (
    step.__step__ + "-" + (stepContext.transactionId ?? ulid()) +
    (stepContext.attempt > 1 ? `-attempt-${stepContext.attempt}` : "")
  )
}
```

**ATHITI translation (very cheap):** make your transition endpoint accept an
`Idempotency-Key` header, store it with a unique index on the booking-request row, and
return the stored result on replay. That is ~15 lines and gives you "the traveller
double-tapped Accept" safety for free. This is a *different* mechanism from pretix's
advisory lock and they compose: the lock stops oversell, the idempotency key stops
double-transitions.

### 4.7 Retry: temp failure vs permanent failure

`packages/core/orchestration/src/transaction/transaction-orchestrator.ts:793-828`:

```typescript
if (
  !isTimeout &&
  step.getStates().status !== TransactionStepStatus.PERMANENT_FAILURE
) {
  step.changeStatus(TransactionStepStatus.TEMPORARY_FAILURE)
}

const flow = transaction.getFlow()
…
const hasTimedOut = step.getStates().state === TransactionStepState.TIMEOUT
if (step.failures > maxRetries || hasTimedOut) {
  if (!hasTimedOut) { step.changeState(TransactionStepState.FAILED) }
  step.changeStatus(TransactionStepStatus.PERMANENT_FAILURE)
  …
  transaction.addError(step.definition.action!, handlerType, error)
}
```

`step.failures` is incremented at `transaction-orchestrator.ts:776`. Once
`failures > maxRetries` (or a timeout fires) the step goes `PERMANENT_FAILURE` and
**compensation begins** for every completed step before it.

### 4.8 The state enums (three of them — this is the real design)

`packages/core/utils/src/orchestration/types.ts:1-35`, in full:

```typescript
export enum TransactionHandlerType {
  INVOKE = "invoke",
  COMPENSATE = "compensate",
}

export enum TransactionState {
  NOT_STARTED = "not_started",
  INVOKING = "invoking",
  WAITING_TO_COMPENSATE = "waiting_to_compensate",
  COMPENSATING = "compensating",
  DONE = "done",
  REVERTED = "reverted",
  FAILED = "failed",
}

export enum TransactionStepState {
  NOT_STARTED = "not_started",
  INVOKING = "invoking",
  COMPENSATING = "compensating",
  DONE = "done",
  REVERTED = "reverted",
  FAILED = "failed",
  DORMANT = "dormant",
  SKIPPED = "skipped",
  SKIPPED_FAILURE = "skipped_failure",
  TIMEOUT = "timeout",
}

export enum TransactionStepStatus {
  IDLE = "idle",
  OK = "ok",
  WAITING = "waiting_response",
  TEMPORARY_FAILURE = "temp_failure",
  PERMANENT_FAILURE = "permanent_failure",
}
```

The insight: **`state` and `status` are orthogonal axes.** `state` is *where in the
lifecycle*; `status` is *health of the current attempt*. A step is
`{ state: INVOKING, status: TEMPORARY_FAILURE }` and will be retried; it is
`{ state: FAILED, status: PERMANENT_FAILURE }` and will trigger compensation. This
two-axis split is the single best idea to steal from this repo.

### 4.9 The state machine is *enforced in code*, with an allowed-transition table

`packages/core/orchestration/src/transaction/transaction-step.ts:90-126` — the
`allowed` map **is** the state machine, and illegal transitions throw:

```typescript
public changeState(toState: TransactionStepState) {
  const allowed = {
    [TransactionStepState.DORMANT]: [TransactionStepState.NOT_STARTED],
    [TransactionStepState.NOT_STARTED]: [
      TransactionStepState.INVOKING,
      TransactionStepState.COMPENSATING,
      TransactionStepState.FAILED,
      TransactionStepState.SKIPPED,
      TransactionStepState.SKIPPED_FAILURE,
    ],
    [TransactionStepState.INVOKING]: [
      TransactionStepState.FAILED,
      TransactionStepState.DONE,
      TransactionStepState.TIMEOUT,
      TransactionStepState.SKIPPED,
    ],
    [TransactionStepState.COMPENSATING]: [
      TransactionStepState.REVERTED,
      TransactionStepState.FAILED,
    ],
    [TransactionStepState.DONE]: [TransactionStepState.COMPENSATING],
  }

  const curState = this.getStates()
  if (curState.state === toState || allowed?.[curState.state]?.includes(toState)) {
    curState.state = toState
    return
  }

  throw new MedusaError(
    MedusaError.Types.NOT_ALLOWED,
    `Updating State from "${curState.state}" to "${toState}" is not allowed.`,
  )
}
```

**`[DONE]: [COMPENSATING]` is the compensation edge.** A finished step can be rolled
back, but a failed one cannot. Copy this table shape verbatim for our booking machine.

Note also `beginCompensation` (`transaction-step.ts:71-80`) resets
`attempts`/`failures` — compensation is a *second lifecycle*, not an error path.

### 4.10 Durable execution: the `workflow_execution` table

`packages/modules/workflow-engine-inmemory/src/models/workflow-execution.ts:4-58`, in
full:

```typescript
export const WorkflowExecution = model
  .define("workflow_execution", {
    id: model.id({ prefix: "wf_exec" }),
    workflow_id: model.text().primaryKey(),
    transaction_id: model.text().primaryKey(),
    run_id: model.text().primaryKey(),
    execution: model.json().nullable(),
    context: model.json().nullable(),
    state: model.enum(TransactionState),
    retention_time: model.number().nullable(),
  })
  .indexes([
    { on: ["workflow_id", "transaction_id", "run_id"], unique: true, where: "deleted_at IS NULL" },
    { on: ["state", "updated_at"], where: "deleted_at IS NULL" },
    …
  ])
```

So yes: **a durable-execution table exists.** Three observations:

1. **`state` is a DB enum of `TransactionState`** — the same 7 values as §4.8.
2. **`execution` is a JSON blob** holding the whole flow (all `TransactionStep`
   objects: `state`, `status`, `attempts`, `failures`, `next[]`, `_v` — see
   `transaction-step.ts:42-65`). The relational columns are just an index for finding
   the row.
3. **The unique index is `(workflow_id, transaction_id, run_id)`** — so a given
   transaction can be re-run with a new `run_id`, but not duplicated within a run.
   `run_id` defaults to `context?.runId ?? ulid()` (`transaction-orchestrator.ts:1554`).

There is a `workflow-engine-redis` variant too
(`packages/modules/workflow-engine-redis/`), so the engine is swappable.

### 4.11 Combinators

Alongside `createStep`/`createWorkflow`: `parallelize`
(`packages/core/workflows-sdk/src/utils/composer/parallelize.ts`), `when`
(`.../when.ts`) for conditional steps, `transform` (`.../transform.ts`) for pure data
mapping, `createHook` (`.../create-hook.ts`) for before/after hooks, and
`createStep(...).config({...})` / `.if(input, cond)` for per-use-site overrides
(`create-step.ts:206-286`).

`WorkflowResponse` marks the workflow's return value —
`packages/core/workflows-sdk/src/utils/composer/helpers/workflow-response.ts:7-25` —
and `workflow().run({ input })` resolves to `{ result, errors }` (as used throughout
`packages/core/workflows-sdk/src/utils/composer/__tests__/compose.spec.ts`).

A minimal real workflow (from the test suite,
`packages/core/workflows-sdk/src/utils/composer/__tests__/compose.spec.ts:159-170`):

```typescript
const step1 = createStep("step1", mockStep1Fn)
const step2 = createStep("step2", mockStep2Fn)
const step3 = createStep("step3", mockStep3Fn)

const workflow = createWorkflow("workflow1", function (input) {
  const returnStep1 = step1(input)
  const ret2 = step2(returnStep1)
  return new WorkflowResponse(step3({ one: returnStep1, two: ret2 }))
})

const { result: workflowResult } = await workflow().run({ input: workflowInput })
```

Note the dataflow: `step2`'s input is `step1`'s **proxy**, and it's passed *before*
step1 has run.

### 4.12 Verdict on Medusa for ATHITI

**Do not build this.** It is ~3000 lines of engine, a container/DI layer, two engine
implementations (in-memory + redis), 12+ migration files for the execution table, and a
proxy type system. The four ideas worth taking are:

| Idea | Medusa source | Our equivalent |
|---|---|---|
| Orthogonal `state` × `status` axes | `utils/src/orchestration/types.ts:16-35` | `status` + `isFinal` / `lastError` |
| Explicit allowed-transition table that throws | `transaction-step.ts:90-126` | a 20-line `assertTransition()` |
| `compensateInput` ≠ `output` | `helpers/step-response.ts:28-44` | compensation gets just the ids |
| Idempotency by deterministic transaction id | `transaction/types.ts:156-159` + `transaction-orchestrator.ts:1737-1751` | `Idempotency-Key` + unique column |

Alternatively borrow **pretix's** much lighter model: a step list with
`is_applicable`/`is_completed` and redirect-to-first-incomplete
(`src/pretix/presale/checkoutflow.py:195-213`, `src/pretix/presale/views/checkout.py:69-92`).

---

## 5. better-auth: minimum viable two-role setup

### 5.1 The Drizzle adapter

`packages/better-auth/src/adapters/drizzle-adapter/index.ts:1` is a one-line re-export:
`export * from "@better-auth/drizzle-adapter";`. The implementation is
`packages/drizzle-adapter/src/drizzle-adapter.ts` (1276 lines) and it is built on
`createAdapterFactory` (`drizzle-adapter.ts:9-15`).

Its most interesting engineering note is driver-agnostic affected-row normalisation
(`drizzle-adapter.ts:49-70`):

```typescript
/**
 * Derive the number of affected rows from a Drizzle write result.
 *
 * Drizzle returns the raw per-driver result for a non-returning write, so the
 * count lives under a different field per driver: node-postgres / neon expose
 * `rowCount`, postgres-js / bun-sql carry `count` on an Array subclass, mysql2
 * reports `affectedRows` (in a result-header array), planetscale and other
 * serverless drivers use `rowsAffected`, better-sqlite3 uses `changes`, and
 * Cloudflare D1 nests the count under `meta.changes`. …
 */
```

Skip.

### 5.2 Minimum config

`packages/better-auth/src/auth/full.ts:9-31`:

```typescript
/**
 * Better Auth initializer for full mode (with Kysely)
 *
 * @example
 * ```ts
 * import { betterAuth } from "better-auth";
 *
 * const auth = betterAuth({
 * 	database: new PostgresDialect({ connection: process.env.DATABASE_URL }),
 * });
 * ```
 *
 * For minimal mode (without Kysely), import from "better-auth/minimal" instead
 * @example
 * ```ts
 * import { betterAuth } from "better-auth/minimal";
 *
 * const auth = betterAuth({
 *   database: drizzleAdapter(db, { provider: "pg" }),
 * });
 */
export const betterAuth = <Options extends BetterAuthOptions>(options: Options & {}): Auth<Options> => {
	return createBetterAuth(options, init);
};
```

**ATHITI minimum** (INFERENCE, assembled from the above + the two-role options below):

```typescript
// lib/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";        // gives you user.role
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  plugins: [
    admin(),                       // adds user.role = "user" | "admin"
    nextCookies(),                 // must be LAST
  ],
  user: {
    additionalFields: {
      // traveller vs provider. null = traveller.
      role: { type: "string", required: false, defaultValue: "traveller", input: false },
    },
  },
});
```

Two things to get right:
- `nextCookies()` must be the **last** plugin (standard better-auth requirement for
  Next.js).
- The `admin` plugin's `role` field is `input: false`
  (`packages/better-auth/src/plugins/admin/schema.ts:6-10`) — a client cannot
  self-assign it:

```typescript
export const schema = {
	user: {
		fields: {
			role: { type: "string", required: false, input: false },
			banned: { type: "boolean", defaultValue: false, required: false, input: false },
			banReason: { type: "string", required: false, input: false },
			banExpires: { type: "date", required: false, input: false },
		},
	},
	session: {
		fields: {
			impersonatedBy: { type: "string", required: false, input: false },
		},
	},
} satisfies BetterAuthPluginDBSchema;
```

`additionalFields` is a first-class extension point
(`packages/core/src/db/get-tables.ts:243-244`):

```typescript
			...user?.fields,
			...options.user?.additionalFields,
		},
		order: 1,
```

and its type is `additionalFields?: { [Key in Exclude<string, Keys | "id">]: DBFieldAttribute }`
(`packages/core/src/types/init-options.ts:246-248`).

### 5.3 The four core tables

Generated by `getAuthTablesWithResolvedIndexes` (`packages/core/src/db/get-tables.ts`).
**Do not hand-write these** — run `npx @better-auth/cli generate`.

**`user`** (`get-tables.ts:197-244`): `id`, `name` (required), `email` (required, unique),
`emailVerified` (bool, `input: false`), `image`, `createdAt`, `updatedAt`
(`onUpdate`). Plus your `additionalFields`.

**`session`** (`get-tables.ts:131-192`):

```typescript
	const sessionTable = {
		session: {
			modelName: options.session?.modelName || "session",
			indexes: session?.indexes,
			fields: {
				expiresAt: { type: "date", required: true, … },
				token: { type: "string", required: true, unique: true, … },
				createdAt: { type: "date", required: true, defaultValue: () => new Date(), … },
				updatedAt: { type: "date", required: true, onUpdate: () => new Date(), … },
				ipAddress: { type: "string", required: false, … },
				userAgent: { type: "string", required: false, … },
				userId: {
					type: "string",
					references: {
						model: "user", field: "id", onDelete: "cascade",
					},
					required: true,
					index: true,
				},
```

So: **sessions are server-side rows, looked up by a unique `token`, with
`expiresAt`, `ipAddress` and `userAgent`.** No JWT required. The `session` table is
omitted entirely if you use `secondaryStorage` *and* don't set
`session.storeSessionInDatabase` (`get-tables.ts:248-251`):

```typescript
		//only add session table if it's not stored in secondary storage
		...(!options.secondaryStorage || options.session?.storeSessionInDatabase
			? sessionTable
			: {}),
```

**`account`** (`get-tables.ts:252+`): `accountId`, `providerId`, `userId` FK,
`password` (for email+password), `token`/`secret`/`accessToken`/`refreshToken`,
timestamps.

**`verification`** (`get-tables.ts:91-121`): `identifier`, `value`, `expiresAt`,
`createdAt`, `updatedAt` — used for email OTP / magic links.

### 5.4 Getting the current user in a route handler

`packages/better-auth/src/api/routes/session.ts:453-495`:

```typescript
export const getSessionFromCtx = async <
	U extends Record<string, any> = Record<string, any>,
	S extends Record<string, any> = Record<string, any>,
>(
	ctx: GenericEndpointContext,
	config?: { disableCookieCache?: boolean; disableRefresh?: boolean } | undefined,
) => {
	if (ctx.context.session) {
		return ctx.context.session as { session: S & Session; user: U & User };
	}

	const session = await getSession()({
		...ctx,
		method: "GET",
		asResponse: false,
		headers: ctx.headers!,
		returnHeaders: true,
		returnStatus: false,
		query: { … },
	}).catch(() => { return null; });
```

Note the **cookie cache**: better-auth caches the session in a signed cookie, so
`getSession` can skip a DB round-trip; `disableCookieCache` forces validation. For
ATHITI, when the request will *mutate* a booking, use `disableCookieCache: true` — a
stale cached session must not authorise a state transition.

**ATHITI pattern** (INFERENCE from the above):

```typescript
// app/api/requests/[id]/accept/route.ts
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (session.user.role !== "provider") return Response.json({ error: "forbidden" }, { status: 403 });
  // … authorisation against the booking's providerId, then the state transition
}
```

### 5.5 Two-role modelling: user-level vs org-level

Three options, in increasing complexity:

1. **`user.role` string** — the `admin` plugin gives you `role` on `user`
   (`plugins/admin/schema.ts:6-10`) and tests use `["user", "admin"]`
   (`plugins/admin/admin.test.ts:224`). For traveller/provider, add your own
   `additionalFields.role`. Simplest; sufficient if one provider = one login.

2. **`user.additionalFields.isProvider` boolean** — a boolean, not an enum, if a user
   is *both*. Fine for a hackathon.

3. **The `organization` plugin** — a real `Organization` with `Member` rows carrying
   per-org roles, and a **capability-based** access control system. The built-in
   statements and roles (`packages/better-auth/src/plugins/organization/access/statement.ts:3-41`, in full):

```typescript
export const defaultStatements = {
	organization: ["update", "delete"],
	member: ["create", "update", "delete"],
	invitation: ["create", "cancel"],
	team: ["create", "update", "delete"],
	ac: ["create", "read", "update", "delete"],
} as const;

export const defaultAc = createAccessControl(defaultStatements);

export const adminAc = defaultAc.newRole({
	organization: ["update"],
	invitation: ["create", "cancel"],
	member: ["create", "update", "delete"],
	team: ["create", "update", "delete"],
	ac: ["create", "read", "update", "delete"],
});

export const ownerAc = defaultAc.newRole({
	organization: ["update", "delete"],
	member: ["create", "update", "delete"],
	invitation: ["create", "cancel"],
	team: ["create", "update", "delete"],
	ac: ["create", "read", "update", "delete"],
});

export const memberAc = defaultAc.newRole({
	organization: [],
	member: [],
	invitation: [],
	team: [],
	ac: ["read"], // Allow members to see all roles for their org.
});

export const defaultRoles = { admin: adminAc, owner: ownerAc, member: memberAc };
```

The interesting pattern is `statements` (resource × verb) + `newRole(statementMap)`:
you declare verbs once and compose roles. ATHITI's analogue would be:

```typescript
export const statements = {
  listing:  ["create", "update", "publish", "delete"],
  request:  ["accept", "decline", "cancel", "reschedule"],
  review:   ["create"],
} as const;
```

**Recommendation: option 1 or 2 for v1.** The organisation plugin adds 3 tables
(`organization`, `member`, `invitation`) and an invitations flow; it is real gold-plating
for a 1-week build unless a provider has staff.

---

## 6. Drizzle patterns worth copying

### 6.1 Table + typed export

`drizzle-orm/type-tests/pg/tables.ts:53-56` and the type-level assertions at
`tables.ts:70-73`:

```typescript
export const myEnum = pgEnum('my_enum', ['a', 'b', 'c']);

export const identityColumnsTable = pgTable('identity_columns_table', {
	generatedCol: integer('generated_col').generatedAlwaysAs(1),
	alwaysAsIdentity: integer('always_as_identity').generatedAlwaysAsIdentity(),
	name: text('name'),
});

Expect<Equal<InferSelectModel<typeof identityColumnsTable>, typeof identityColumnsTable['$inferSelect']>>;
Expect<Equal<InferInsertModel<typeof identityColumnsTable>, typeof identityColumnsTable['$inferInsert']>>;
```

`$inferSelect` / `$inferInsert` are properties hung off the table object; the canonical
export form (INFERENCE, standard drizzle practice, not shown verbatim in this clone) is:

```typescript
// db/schema/listings.ts
export const listings = pgTable("listing", { … });
export type Listing    = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
```

Use `.$inferSelect` rather than the `InferSelectModel<>` helper — it is the same thing
and reads better.

### 6.2 Relations (v1 API) — the pattern to copy

`drizzle-orm/type-tests/pg/tables-rel.ts:11-45`:

```typescript
export const usersConfig = relations(users, ({ one, many }) => ({
	city: one(cities, { relationName: 'UsersInCity', fields: [users.cityId], references: [cities.id] }),
	homeCity: one(cities, { fields: [users.homeCityId], references: [cities.id] }),
	posts: many(posts),
	comments: many(comments),
}));

export const cities = pgTable('cities', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
});
export const citiesConfig = relations(cities, ({ many }) => ({
	users: many(users, { relationName: 'UsersInCity' }),
}));

export const posts = pgTable('posts', {
	id: serial('id').primaryKey(),
	title: text('title').notNull(),
	authorId: integer('author_id').references(() => users.id),
});
export const postsConfig = relations(posts, ({ one, many }) => ({
	author: one(users, { fields: [posts.authorId], references: [users.id] }),
	comments: many(comments),
}));
```

**Two relations to the same table need an explicit `relationName`** (`UsersInCity` on
lines 12 and 23). This matters for us: a booking request relates to a traveller and a
provider, and a review relates to an author and a subject — all `user` rows. Without
`relationName`, drizzle cannot disambiguate.

### 6.3 Relation queries — nested, typed, `with`

`drizzle-orm/type-tests/pg/db-rel.ts:12-49`:

```typescript
	const result = await db.query.users.findMany({
		where: (users, { sql }) => sql`char_length(${users.name} > 1)`,
		limit: sql.placeholder('l'),
		orderBy: (users, { asc, desc }) => [asc(users.name), desc(users.id)],
		with: {
			posts: {
				where: (posts, { sql }) => sql`char_length(${posts.title} > 1)`,
				limit: sql.placeholder('l'),
				columns: { id: false, title: undefined },
				with: {
					author: true,
					comments: {
						where: (comments, { sql }) => sql`char_length(${comments.text} > 1)`,
						columns: { text: true },
						with: { author: { columns: { id: undefined }, with: { city: { with: { users: true } } } } },
					},
				},
			},
		},
	});
```

`columns: { id: false, title: undefined }` is the **column-subset projection** — you can
omit columns and the result type narrows. Worth using on listings (don't ship
`internal_notes` to the client). This is a real defence-in-depth pattern: define
`publicListingColumns` and reuse it on every read.

The query builder is *callback-scoped*: `users`, `{ sql, asc, desc }` are the
parameters, so you cannot accidentally reference an un-imported table.

### 6.4 `FOR UPDATE` — Drizzle has it

`drizzle-orm/src/pg-core/query-builders/select.types.ts:151-165`:

```typescript
export type LockStrength = 'update' | 'no key update' | 'share' | 'key share';

export type LockConfig =
	& {
		of?: ValueOrArray<PgTable>;
	}
	& ({
		noWait: true;
		skipLocked?: undefined;
	} | {
		skipLocked: true;
		noWait?: undefined;
	} | {
		skipLocked?: undefined;
		noWait?: undefined;
	});
```

and the implementation — `drizzle-orm/src/pg-core/query-builders/select.ts:979-981`:

```typescript
	for(strength: LockStrength, config: LockConfig = {}): PgSelectWithout<this, TDynamic, 'for'> {
		this.config.lockingClause = { strength, config };
		return this as any;
	}
```

This maps **exactly** onto pretix's `select_for_update(of=OF_SELF)`
(`domain/pretix/src/pretix/base/models/base.py:248`) and
`skip_locked=connection.features.has_select_for_update_skip_locked`
(`domain/pretix/src/pretix/base/services/mail.py:1107`).

**Recommendation: for ATHITI use `pg_advisory_xact_lock`, not `.for('update')`.** Row
locks on a capacity row work, but the lock queue is FIFO per row and a long-held lock
blocks *reads* under `SELECT ... FOR UPDATE`-heavy patterns; advisory locks with
`lock_timeout` + retry give you a cleaner busy-path. Drizzle's escape hatch:

```typescript
await db.execute(sql`select pg_advisory_xact_lock(hashtext(${listingId}::text))`);
```

…inside `db.transaction(async (tx) => { … })`. But if you use **SQLite** (very likely in
a hackathon), advisory locks don't exist — use `.for('update')` if on Postgres, and on
SQLite just rely on the database's whole-file write lock plus a `UNIQUE` guard.

### 6.5 Migrations workflow

Not implemented in this clone's type-tests, so INFERENCE from the structure: drizzle
separates **schema definition** (your code) from **migration generation**
(`drizzle-kit`, `drizzle-kit/` at the repo root) and **migration application**
(`drizzle-orm/src/migrator.ts`, driver-agnostic). The workflow is:

1. edit `db/schema/*.ts`
2. `npx drizzle-kit generate` → emits SQL in `drizzle/` + a journal
3. `npx drizzle-kit migrate` (or `migrate(db, migrationsFolder)`) at boot/deploy

**ATHITI advice: skip the migration tool.** For a 1-week build with one Postgres and
no production, write `db/schema.ts` and run `drizzle-kit push` (no migration files), or
even `CREATE TABLE` by hand once. The migration tool earns its keep on the second
schema change, and you will have ~15 of those in week one.

### 6.6 Three snippets to copy

**(a) `db/schema/booking.ts` — listing, occurrence, capacity pool, request.**

```typescript
// db/schema/booking.ts
import { pgTable, pgEnum, uuid, text, integer, boolean, timestamp, index, uniqueIndex }
  from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const requestStatus = pgEnum("request_status", [
  "pending", "accepted", "declined", "cancelled", "expired", "completed",
]);

export const listings = pgTable("listing", {
  id:            uuid("id").primaryKey().defaultRandom(),
  providerId:    uuid("provider_id").notNull().references(() => users.id),
  title:         text("title").notNull(),
  description:   text("description"),
  capacity:      integer("capacity"),                 // NULL = unlimited  (pretix Quota.size)
  requiresApproval: boolean("requires_approval").notNull().default(true),
  bookFrom:      timestamp("book_from", { withTimezone: true }),
  bookUntil:     timestamp("book_until", { withTimezone: true }),
  active:        boolean("active").notNull().default(false),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("listing_provider_idx").on(t.providerId)]);

export const occurrences = pgTable("occurrence", {
  id:        uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  startsAt:  timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt:    timestamp("ends_at",   { withTimezone: true }).notNull(),
  capacity:  integer("capacity"),                       // overrides listing.capacity when set
}, (t) => [uniqueIndex("occurrence_listing_start_uq").on(t.listingId, t.startsAt)]);

export const requests = pgTable("request", {
  id:           uuid("id").primaryKey().defaultRandom(),
  occurrenceId: uuid("occurrence_id").notNull().references(() => occurrences.id),
  travellerId:  uuid("traveller_id").notNull().references(() => users.id),
  providerId:   uuid("provider_id").notNull().references(() => users.id),  // denormalised for the inbox query
  partySize:    integer("party_size").notNull().default(1),
  status:       requestStatus("status").notNull().default("pending"),
  message:      text("message"),
  expiresAt:    timestamp("expires_at", { withTimezone: true }).notNull(),
  idempotencyKey: text("idempotency_key"),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("request_provider_status_idx").on(t.providerId, t.status),   // the provider inbox
  index("request_occurrence_status_idx").on(t.occurrenceId, t.status), // the capacity sum
  uniqueIndex("request_idempotency_uq").on(t.idempotencyKey),
]);

export type Listing      = typeof listings.$inferSelect;
export type NewListing   = typeof listings.$inferInsert;
export type Request      = typeof requests.$inferSelect;
export type NewRequest   = typeof requests.$inferInsert;
```

Notes: `providerId` on `requests` is denormalised on purpose — the provider inbox query
("all pending requests for me") becomes a single index scan, and it mirrors pretix's
`Order.organizer` "Redundant foreign key, but is required for a uniqueness constraint"
(`domain/pretix/src/pretix/base/models/orders.py:223-228`). The **unique index on
`idempotency_key`** is the Medusa idempotency mechanism (§4.6) reduced to one line.

**(b) The capacity sum — pretix's aggregate, in one query.**

```typescript
// capacity is DERIVED, never stored (pretix quotas.py:226-500)
export async function remainingCapacity(tx: Tx, occurrenceId: string) {
  const [row] = await tx
    .select({
      accepted: sql<number>`coalesce(sum(${requests.partySize}) filter (where ${requests.status} in ('accepted')), 0)`,
      pending:  sql<number>`coalesce(sum(${requests.partySize}) filter (where ${requests.status} in ('pending')), 0)`,
    })
    .from(requests)
    .where(and(eq(requests.occurrenceId, occurrenceId),
               inArray(requests.status, ["pending", "accepted"])));
  return { taken: Number(row.accepted) + Number(row.pending) };
}
```

That is the *whole* of pretix's 275-line `_compute_orders` + `_compute_carts` +
`_compute_waitinglist`, for a two-state model. pretix needs the complexity because it
has carts, vouchers, waiting lists, seats, check-in and 20 years of edge cases.

**(c) The guarded transition — advisory lock, re-count, assert, write.**

```typescript
// db/booking/acceptRequest.ts
import { and, eq, sql, inArray } from "drizzle-orm";
import { db } from "@/db";
import { requests, occurrences } from "@/db/schema/booking";

export async function acceptRequest(requestId: string, providerId: string) {
  return db.transaction(async (tx) => {
    // 1. lock the occurrence row. (pg_advisory_xact_lock in pretix; row lock here.)
    const [occ] = await tx
      .select()
      .from(occurrences)
      .where(eq(occurrences.id,
        (await tx.select({ id: occurrences.id }).from(requests)
           .where(eq(requests.id, requestId))).occurrenceId))
      .for("update");
    if (!occ) throw new Error("not found");

    // 2. re-count INSIDE the lock (pretix orders.py:776-799 then :1109-1128)
    const [row] = await tx
      .select({ taken: sql<number>`coalesce(sum(${requests.partySize}), 0)` })
      .from(requests)
      .where(and(eq(requests.occurrenceId, occ.id),
                 inArray(requests.status, ["pending", "accepted"])));
    const cap = occ.capacity;
    if (cap != null && Number(row.taken) > cap) {
      throw new SoldOutError();                       // -> 409, retried by the caller
    }

    // 3. transition, guarded on the *current* status (medusa transaction-step.ts:90-126)
    const [updated] = await tx
      .update(requests)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(and(eq(requests.id, requestId),
                 eq(requests.providerId, providerId),
                 eq(requests.status, "pending")))   // the assert-transition
      .returning();
    if (!updated) throw new ConflictError();
    return updated;
  });
}
```

`where eq(requests.status, "pending")` **is** the state-machine assertion: a
conditional `UPDATE` that matches zero rows means the transition was illegal. This is
the cheapest correct state machine in existence and it needs no engine at all.

---

## 7. Trust & reputation mechanics

### 7.1 trustroots — the mutual-attestation model (best fit for ATHITI)

`domain/trustroots/modules/experiences/server/models/experiences.server.model.js:12-63`,
in full:

```javascript
const ExperienceSchema = new Schema({
  created: { type: Date, default: () => Date.now(), required: true },
  public:  { type: Boolean, default: false, required: true },
  userFrom: { type: Schema.ObjectId, ref: 'User', required: true },
  userTo:   { type: Schema.ObjectId, ref: 'User', required: true },
  interactions: {
    met:   { type: Boolean, default: false, required: true },
    guest: { type: Boolean, default: false, required: true },
    host:  { type: Boolean, default: false, required: true },
  },
  recommend: {
    type: String,
    enum: ['yes', 'no', 'unknown'],
    default: 'unknown',
    required: true,
  },
  feedbackPublic: { type: String, trim: true },
});

ExperienceSchema.plugin(uniqueValidation);
ExperienceSchema.index({ userFrom: 1, userTo: 1, public: 1, created: 1 });
ExperienceSchema.index({ userFrom: 1, userTo: 1 }, { unique: true });
```

Seven design decisions here, all copyable:

1. **A trust signal is a row between two users, not a column on a user.** Reputation is
   computed, never stored.
2. **`userFrom`/`userTo` are asymmetric, and the unique index is `(userFrom, userTo)`
   only.** A can leave one Experience about B; B leaves a *separate* one about A.
   Reciprocity is represented by two rows, not a self-loop. This is the right model.
3. **`public: false` by default.** Testimonials are private until the author publishes
   them. Privacy-by-default, not opt-in.
4. **`recommend` is a 3-state enum `yes | no | unknown`,** not a 1–5 star score. `unknown`
   is load-bearing: it distinguishes "would recommend" from "not enough interaction to
   say". A 5-star scale cannot express this.
5. **`interactions` is three independent booleans** — `met`, `guest`, `host` — so "we met
   in person" and "I hosted them" and "they hosted me" are separately attestable.
6. **`feedbackPublic` is free text and optional** (`Feedback.js:39-42` renders "(Optional)").
7. **A compound index `(userFrom, userTo, public, created)`** for the timeline query, plus
   the unique pair for the "already reviewed" check.

The UI reveals the intended flow. `Interaction.js:23-46` — three checkboxes:

```javascript
              checked={interactions.met}
              onChange={() => onChange('met')}
…
              checked={interactions.host}
              onChange={() => onChange('host')}
              {t('I hosted them')}
…
              checked={interactions.guest}
              onChange={() => onChange('guest')}
              {t('They hosted me')}
```

The recommend question is *adapted to the primary interaction*
(`Recommend.js:36-45`):

```javascript
  const recommendQuestions = {
    guest: t('Besides your personal experience, would you recommend others to stay with them?'),
    host:  t('Besides your personal experience, would you recommend others to host them?'),
    met:   t('Besides your personal experience, would you recommend others to meet them?'),
  };
```

### 7.2 Reporting is a *separate* concern from the review

`CreateExperience.component.js:84-87`:

```javascript
    const [savedExperience] = await Promise.all([
      experiencesApi.create({ ...experience, userTo: userTo._id }),
      recommend === 'no' && report
        ? supportApi.reportMember(userTo, reportMessage)
        : null,
    ]);
```

A negative review fires **two independent side effects**: the Experience row, and a
private report to moderators. The report goes to a *different* module
(`modules/support/`) and the `Experience` schema has **no** report field. Privacy: the
moderator channel is not visible to the reported user.

`Report.js:24-27` makes the framing explicit:

```javascript
        {t(
          "It's extremely important you report anyone behaving against community rules or values to us.",
        )}
```

with the switch labelled `'Privately report this person to the moderators'` and a
required free-text `'Message to the moderators'`.

### 7.3 trustroots roles (an 8-value enum, real moderation tiers)

`domain/trustroots/modules/users/server/models/user.server.model.js:262-279`:

```javascript
  roles: {
    type: [
      {
        type: String,
        enum: [
          'admin',
          'welcome-team',
          'moderator',
          'shadowban',
          'suspended',
          'user',
          'volunteer-alumni',
          'volunteer',
        ],
      },
    ],
    default: ['user'],
  },
```

Read these carefully — they encode a mature community's hard-won moderation design:
- `shadowban` and `suspended` are **distinct** from `banned`: a shadowbanned user does
  not know they've been sanctioned, so they keep interacting and reveal the ring of
  accounts they created.
- `welcome-team` is a **structured peer-review role** — new accounts are vetted by
  existing members. That is a trust-tier mechanism.
- `volunteer` / `volunteer-alumni` is a **status tier** with history preserved.
- Roles are an **array**, so trust is not a single ladder.

Enforcement is role-based via an ACL —
`domain/trustroots/modules/experiences/server/policies/experiences.server.policy.js:1-27`:

```javascript
const acl = require('../../../core/server/services/memory-policy.server.service')();

exports.invokeRolesPolicies = function () {
  acl.allow([
    {
      roles: ['user', 'admin'],
      allows: [
        { resources: '/api/experiences', permissions: ['get', 'post'] },
        …
      ],
    },
  ]);
};
```

**ATHITI verdict: 3 roles is right — `traveller`, `provider`, `admin`. Do NOT build
`shadowban`, `welcome-team`, or `volunteer-alumni`.**

### 7.4 rox — 21 member statuses, and why most are a mistake to copy

`domain/rox/src/Doctrine/MemberStatusType.php:7-28`, the enum in full:

```php
    public const string AWAITING_MAIL_CONFIRMATION = 'MailToConfirm';
    public const string MAIL_CONFIRMED = 'MailConfirmed';
    public const string PENDING = 'Pending';
    public const string DUPLICATE_SIGNED = 'DuplicateSigned';
    public const string NEED_MORE = 'NeedMore';
    public const string REJECTED = 'Rejected';
    public const string COMPLETED_PENDING = 'CompletedPending';
    public const string ACTIVE = 'Active';
    public const string ACCOUNT_ACTIVATED = 'Activated';
    public const string TAKEN_OUT = 'TakenOut';
    public const string BANNED = 'Banned';
    public const string SLEEPER = 'Sleeper';
    public const string CHOICE_INACTIVE = 'ChoiceInactive';
    public const string OUT_OF_REMIND = 'OutOfRemind';
    public const string RENAMED = 'Renamed';
    public const string ACTIVE_HIDDEN = 'ActiveHidden';
    public const string SUSPENDED = 'SuspendedBeta';
    public const string ASKED_TO_LEAVE = 'AskToLeave';
    public const string STOP_BORING_ME = 'StopBoringMe';
    public const string PASSED_AWAY = 'PassedAway';
    public const string BUGGY = 'Buggy';
```

**21 statuses, and it is a liability.** Notice: `ACTIVE` vs `ACTIVE_HIDDEN` differ only
by whether the profile is listed; `CHOICE_INACTIVE`, `OUT_OF_REMIND` and `SLEEPER` are
notification-preference states masquerading as account states; `BUGGY`, `RENAMED`,
`TAKEN_OUT` and `PASSED_AWAY` are operational or editorial states. The field is
`private string $status = 'Incomplete'` (`src/Entity/Member.php:95-96`) — a plain
string, so there is no type safety at the call site either.

And note the *hack* they needed because of it — `MemberStatusType.php:30-59`. Statuses
are grouped by ad-hoc SQL fragments because you cannot express "active-ish" as a
single enum member:

```php
    public const string ACTIVE_ALL = "'" .
        self::ACTIVE . "', '" .
        self::ACTIVE_HIDDEN . "', '" .
        self::CHOICE_INACTIVE . "', '" .
        self::OUT_OF_REMIND . "', '" .
        self::PENDING . "'";

    public const array ACTIVE_ALL_ARRAY = [ … ];

    public const string ACTIVE_SEARCH = "'" .
        self::ACTIVE . "', '" .
        self::ACTIVE_HIDDEN . "', '" .
        self::OUT_OF_REMIND . "', '" .
        self::PENDING . "'";
```

**Lesson: orthogonal concerns (trust tier, visibility, notification prefs, editorial
suspension) must be separate columns, not one status enum.** This is exactly the mistake
Medusa avoided by splitting `state` × `status` (§4.8). Do not repeat rox's error.

**What rox gets right, and is worth copying:**

*Member profile signals* — a rich, human, non-numeric profile
(`src/Entity/Member.php:113-220`):

```php
    #[ORM\Column(name: 'Accommodation', type: 'accommodation', nullable: true)]
    private ?string $accommodation = null;

    #[ORM\Column(name: 'AdditionalAccommodationInfo', type: 'string', nullable: true)]
    #[Gedmo\Translatable]
    private ?string $additionalAccommodationInfo = null;

    #[ORM\Column(name: 'StandardOffers', type: 'standard_offers', nullable: true)]
    private ?string $standardOffers = null;

    #[ORM\Column(name: 'MaxGuests', type: 'integer', nullable: false)]
    private int $maxGuests = 1;

    #[ORM\Column(name: 'MaxLengthOfStay', type: 'string', nullable: true)]
    #[Gedmo\Translatable]
    private ?string $maxLengthOfStay = null;

    #[ORM\Column(name: 'Restrictions', type: 'host_restrictions', nullable: true)]
    #[ORM\Column(name: 'HouseRules', type: 'string', nullable: true)]
```

`HouseRules`, `WhereYouSleep`, `PleaseBring`, `Occupation`, `Hobbies`, `Books`, `Music`,
`Movies`, `PastTrips`, `PlannedTrips` (`Member.php:153-207`) — a *human* profile, no
star-ratings anywhere. And `StandardOffers` is a **set** type
(`src/Doctrine/StandardOffersType.php:7-15`):

```php
    public const string DINNER = 'dinner';
    public const string GUIDED_TOUR = 'guidedtour';

    protected string $name = 'standard_offers';

    protected array $values = [
        self::DINNER,
        self::GUIDED_TOUR,
    ];
```

ATHITI analogue: `provider.offers = { dinner, guided_tour, workshop, performance }`.
Cheap, useful for filtering, and it demos well.

*Per-field privacy by bitmask* — `Member.php:64-70`:

```php
    public const int NAME_HIDDEN = 1;
    public const int GENDER_HIDDEN = 2;
    public const int AGE_HIDDEN = 4;
    public const int ADDRESS_HIDDEN = 16;

    public const int DEFAULT_HIDDEN =
        self::NAME_HIDDEN | self::GENDER_HIDDEN | self::AGE_HIDDEN | self::ADDRESS_HIDDEN;
```

…stored as `private int $hideAttribute = self::DEFAULT_HIDDEN` (`Member.php:108-109`).
Cute, but a bitmask is unqueryable in SQL. For ATHITI use explicit booleans
(`show_exact_address`, `show_phone`) — 3 booleans, no bit twiddling.

*The request state machine* — `src/Entity/HostingRequest.php:34-38`:

```php
    public const int REQUEST_OPEN = 0;
    public const int REQUEST_CANCELLED = 1;
    public const int REQUEST_DECLINED = 2;
    public const int REQUEST_TENTATIVELY_ACCEPTED = 4;
    public const int REQUEST_ACCEPTED = 8;
```

**`REQUEST_TENTATIVELY_ACCEPTED` is the interesting one** — a "maybe" state. Real
hospitality networks need it because a host must check with their household. Note these
are **bit flags** (0,1,2,4,8) but used as a plain enum; the setter validates by
whitelist (`HostingRequest.php:138-148`):

```php
    public function setStatus(int $status): self
    {
        if (self::REQUEST_OPEN !== $status
            && self::REQUEST_CANCELLED !== $status
            && self::REQUEST_DECLINED !== $status
            && self::REQUEST_TENTATIVELY_ACCEPTED !== $status
            && self::REQUEST_ACCEPTED !== $status) {
            throw new InvalidArgumentException('Request status outside of valid range. Got ' . $status . 'instead of REQUEST_OPEN (0), REQUEST_CANCELLED (1), REQUEST_DECLINED (2), REQUEST_TENTATIVELY_ACCEPTED (4) or REQUEST_ACCEPTED (8) ');
        }
        $this->status = $status;
```

Also on `HostingRequest`: `arrival`/`departure` with cross-field validation
(`HostingRequest.php:44-56`, `Assert\LessThanOrEqual(propertyPath: 'departure')`),
a `flexible` boolean (line 58), and a **party size with a hard cap**
(`HostingRequest.php:60-62`):

```php
    #[ORM\Column(name: 'number_of_travellers', type: 'integer')]
    #[Assert\Range(min: 1, max: 20, minMessage: 'At least one person must travel', maxMessage: 'Hosting more than 20 people is asking for too much')]
    private int $numberOfTravellers = 1;
```

`min: 1` — a party is never 0 people. `max_party` on our listings should have the same
floor.

*Moderation reports* — `src/Doctrine/ReportStatusType.php:6-17`:

```php
    public const string OPEN = 'Open';
    public const string IN_DISCUSSION = 'OnDiscussion';
    public const string CLOSED = 'Closed';
```

*A clean 3-state report lifecycle*, and the right size for a hackathon. And the
`ReportToModerator` entity holds `PostComment`, `ModeratorComment`, `Status`, `Type`,
`LastWhoSpoke`, `IdPost`, `IdThread` (`src/Entity/ReportToModerator.php:27-85`) — a
**two-sided thread** (reporter's text + moderator's reply) plus a `LastWhoSpoke` cursor
for "who needs to act next". Nice: the thread *is* the workflow.

### 7.5 Consolidated trust profile for ATHITI

| Signal | Source | Storage | v1? |
|---|---|---|---|
| Role (traveller/provider/admin) | trustroots:262, better-auth admin plugin | `user.role` / `user.additionalFields` | **yes** |
| `emailVerified` | better-auth core (`get-tables.ts:217-222`) | `user.email_verified` | **yes**, free |
| `recommend: yes\|no\|unknown` | trustroots:44-49 | `review.recommend` enum | **yes** |
| Mutual attestation (A→B, one row) | trustroots:34-37, 60 | `review(from, to)` unique | **yes** |
| `public` toggle on review | trustroots:27-30 | `review.is_public` default false | **yes** |
| Completed-bookings count | **INFERENCE** (derived from `request.status='completed'`) | computed | **yes** |
| Account age | trustroots:294-297 | `user.created_at` | **yes** |
| Free-text feedback | trustroots:51-53 | `review.body` nullable | yes |
| Report to moderators | rox ReportStatusType, trustroots Report.js | `report(status, thread)` | maybe |
| Badges / tiers | *no repo has a badge system* | — | **no** |
| `shadowban`, `suspended` | trustroots:266-270 | `user.roles[]` | **no** |
| `sleeper`, `buggy`, `passed_away`, … | rox MemberStatusType (17 others) | — | **no** |

**No repo in this set has a verification-badge system.** That is a finding, not a gap:
verification badges are a UI affordance over data you already have (email verified +
N completed bookings). Build the data, render the badge.

---

## 8. Group / party modelling

### 8.1 The finding: constraints are SHARED, personas are PER-PERSON

`systems/ai-tour-meeting/tour_meeting/tour_meeting.py:153-186` — the meeting holds
*one* shared constraint dict and *N* per-participant personas:

```python
            constraints: Optional[Union[str, Dict[str, Any]]] = None,
        …
        self.participants: List[Participant] = []
        …
        self._constraints = constraints
        …
        self.participants.append(participant)
```

The shared constraint keys are enumerated — `tour_meeting.py:62-92`:

```python
def build_constraints_text(constraints: Dict[str, Any]) -> str:
    """Build a constraints prompt string from a dict of constraint fields.

    Recognized keys: travel_date, time_window_start, time_window_end, budget.
    Unknown keys are formatted as "Key: value".
    Returns empty string if no constraints are present.
    """
    parts: List[str] = []
    if constraints.get("travel_date"):
        parts.append(f"Travel Date: {constraints['travel_date']}")
    tw_start = constraints.get("time_window_start")
    tw_end = constraints.get("time_window_end")
    if tw_start and tw_end:
        parts.append(f"Time Window: {tw_start} - {tw_end}")
    …
    if constraints.get("budget"):
        parts.append(f"Budget per participant: {constraints['budget']}")
    known_keys = {"travel_date", "time_window_start", "time_window_end", "budget"}
    for key, value in constraints.items():
        if key not in known_keys and value:
            label = key.replace("_", " ").title()
            parts.append(f"{label}: {value}")
```

**Two levels, and the split is deliberate:**

- **Shared** (group-level): `travel_date`, `time_window_start`, `time_window_end`,
  `budget`. These are the *intersection* — you can only pick a date/time the whole group
  can do, and `budget` is explicitly **per participant**.
- **Per-person**: `name`, `background`, `personality`, `preferences`, `personal_goals`,
  `role` — `systems/ai-tour-meeting/tour_meeting/generate_meetings.py:34-46`:

```python
class GeneratedParticipant(BaseModel):
    """A single participant generated by the LLM."""
    name: str = Field(description="Participant's name.")
    background: str = Field(description="Relevant context, experience, or situation.")
    personality: str = Field(description="Stable traits, e.g. cautious, curious, analytical, sociable.")
    preferences: str = Field(description="Likes, dislikes, priorities, and constraints.")
    personal_goals: str = Field(description="Specific goals/preferences for the tour.")
    role: Literal["facilitator", "attendee"] = Field(
        description="Role in the meeting: 'facilitator' or 'attendee'."
    )
    speaking_style: str = Field(description="Tone style (e.g. 'friendly', 'enthusiastic').")
    explanation_style: Literal["auto", "subjective", "contrastive", "both"] = Field(…)
```

`role: Literal["facilitator", "attendee"]` — a discriminated per-person role, at most
one facilitator (`generate_meetings.py:82`).

The `Participant` class mirrors this exactly —
`systems/ai-tour-meeting/tour_meeting/participant.py:726-745`:

```python
class Participant:
    def __init__(
        self,
        llm,
        name: str,
        background: str,
        personality: str,
        preferences: str,
        personal_goals: str,
        role: Literal["facilitator", "attendee"] = "attendee",
        speaking_style: str = "friendly",
        explanation_style: Literal["auto", "subjective", "contrastive", "both"] = "auto",
        …
```

…and holds *copies* of the shared values pushed down from the meeting
(`participant.py:776-780`):

```python
        self.meeting_title: str = ""  # Set by tour_meeting.py before meeting starts
        self.constraints_text: str = ""  # Set by tour_meeting.py before meeting starts
        # Structured time window ("HH:MM" or None), set by tour_meeting.py;
        # used to validate proposed routes mechanically (with retry feedback).
        self.time_window_start: Optional[str] = None
        self.time_window_end: Optional[str] = None
```

**Note `budget` is per-participant** (`tour_meeting.py:81`: `"Budget per participant:"`).
And there is **no per-person budget field** — the *shared* budget is divided. So the
data model is: group has constraints, group has N members, and members have
*preference text* rather than *constraint numbers*.

### 8.2 The conflict-alignment axis — genuinely clever, and demo-able

`systems/ai-tour-meeting/tour_meeting/generate_meetings.py:92-110` defines three
alignment levels, and the `conflicting` prompt is the interesting one
(`generate_meetings.py:102-108`):

```python
    "conflicting": """\
   - Participants' preferences and personal goals must genuinely CONFLICT: include mutually exclusive priorities that CANNOT all be satisfied in a single day, so that satisfying one participant's top priority forces a real sacrifice from another.
   - Use concrete tensions, e.g.: slow immersive pace vs. packed itinerary; quiet cultural sites vs. lively crowded areas; strict low budget vs. upscale experiences; early-morning start vs. late-night focus; staying in one district vs. covering the whole city.
   - Do NOT make the conflicts trivially resolvable, and do NOT resolve them yourself; the discussion is where trade-offs get negotiated.
   - Keep each participant's personal_goals CONCRETE: name specific place types, activities, or experiences they want (e.g. "visit a Zen temple garden", "try a traditional tea house"), not vague wishes like "have a pleasant day".""",
```

The listed tensions (`slow immersive pace vs. packed itinerary`, `strict low budget vs.
upscale experiences`, `early-morning start vs. late-night focus`) are **exactly** the
real conflicts in a group travel booking, and they are pre-computed as a taxonomy.

### 8.3 Group consensus rules — an existing voting-rule taxonomy

`systems/ai-tour-meeting/tour_meeting/tour_meeting.py:102-107`:

```python
_VOTING_RULE_DESCRIPTIONS: Dict[str, str] = {
    "majority": "a proposed route is adopted once it wins a strict majority of votes",
    "unanimous": "a proposed route is adopted only when every participant accepts it",
    "most_pleasure": "a proposed route is adopted when it maximizes the total satisfaction score across participants",
    "least_misery": "a proposed route is adopted when it maximizes the lowest satisfaction score among participants",
    "single_decider": "a single designated decider's accept/reject vote determines whether a proposed route is adopted",
}
```

`least_misery` (max-min fairness) and `most_pleasure` (max-sum) are the standard
multi-objective aggregation pair. With `n` travellers and `k` candidate experiences you
can compute a satisfaction score per (traveller, experience) and rank.

The vote type is a dual-mode scalar — `systems/ai-tour-meeting/tour_meeting/types.py:238-246`:

```python
class Vote(BaseModel):
    """A judgment on another participant's proposal.

    Set ``accept`` for the binary voting rules (majority / unanimous /
    single_decider) or ``score`` (1-10) for most_pleasure / least_misery.
    """
    accept: Optional[bool] = None
    score: Optional[float] = None
    message: str = ""
```

Turn-taking is likewise a taxonomy — `tour_meeting.py:95-101`:

```python
_TURN_RULE_DESCRIPTIONS: Dict[str, str] = {
    "round_robin": "speakers take turns in a fixed, rotating order",
    "random": "the speaking order is randomized; when balanced turns are off, speakers may repeat before everyone has spoken",
    "inviting": "after finishing their turn, each speaker chooses who speaks next",
    "facilitating": "a designated facilitator chooses who speaks next after every turn",
    "parallel": "all eligible voters cast their votes simultaneously and independently, without seeing others' votes first",
}
```

### 8.4 The proposed output shape — a Destination, quoted

`systems/ai-tour-meeting/tour_meeting/participant.py:416-424` (`Destination`), verbatim:

```python
class Destination(BaseModel):
    name: str = Field(default="", description="Destination name.")
    description: str = Field(default="", description="Short highlight or purpose of the visit.")
    transport_mode: str = Field(default="", description="Transportation mode from the previous stop.")
    transport_cost: str = Field(default="", description="Estimated transport cost per participant from the previous stop to this destination. …")
    travel_time_from_previous: str = Field(default="", description="Travel time from the previous stop (e.g., '10 min').")
    start_time: str = Field(default="", description="Planned arrival/start time (e.g., '10:00'). Ensure that ((`start_time` of the previous destination + `stay_duration` of the previous destination) + `travel_time_from_previous` of this destination) does not exceed the `start_time` of this destination.")
    stay_duration: str = Field(default="", description="Expected stay duration (e.g., '60 min').")
    cost: str = Field(default="", description="Estimated cost per participant at this destination. …")
```

Note the **hard temporal-consistency constraint encoded in the field description**:
`start_time[i] >= start_time[i-1] + stay_duration[i-1] + travel_time[i]`. That is a
validatable itinerary constraint. `cost` and `transport_cost` are **per participant**.

### 8.5 ATHITI translation

```typescript
// db/schema/group.ts
export const partyMembers = pgTable("party_member", {
  id:         uuid("id").primaryKey().defaultRandom(),
  requestId:  uuid("request_id").notNull().references(() => requests.id, { onDelete: "cascade" }),
  userId:     uuid("user_id").notNull().references(() => users.id),
  displayName: text("display_name").notNull(),
  role:       memberRoleEnum("role").notNull().default("attendee"),  // facilitator | attendee
  // per-person, free text (ai-tour-meeting: preferences / personal_goals)
  preferences:    text("preferences"),
  personalGoals:  text("personal_goals"),
  // per-person, numeric — INFERENCE: ai-tour-meeting keeps these as text
  maxPriceCents:  integer("max_price_cents"),
  earliestStart:  time("earliest_start"),
  latestEnd:      time("latest_end"),
  isBooker:       boolean("is_booker").notNull().default(false),   // who actually submits
}, (t) => [uniqueIndex("party_member_req_user_uq").on(t.requestId, t.userId)]);
```

Shared constraints live on the **request**, not the party (ai-tour-meeting:
`self._constraints` is on the meeting, `tour_meeting.py:178`):

```typescript
// on `requests`
  requestedFor:  timestamp("requested_for", { withTimezone: true }).notNull(),  // travel_date
  windowStart:   time("window_start"),        // time_window_start
  windowEnd:     time("window_end"),          // time_window_end
  budgetCents:   integer("budget_cents"),     // per participant, shared
  alignment:     alignmentEnum("alignment").default("mixed"),  // aligned | mixed | conflicting
```

**v1 recommendation: ONE request with `party_size` (an integer), plus
`party_members` rows if you want the multi-traveller story.** pretix's
`CartPosition` is a single row with a quantity, and
`HostingRequest.numberOfTravellers` is a single integer
(`src/Entity/HostingRequest.php:60-62`). The full `party_members` table is only needed
if the *provider must see and respond to individuals* (e.g. "6 of 8 confirmed").

The `alignment` field is a **free demo win**: pre-compute 3 personas with conflicting
constraints, show the traveller-side party view, and let the provider see
"3 travellers · budget ≤€40 · one wants early start, one won't do crowds". That is a
30-minute feature with a disproportionate demo payoff, and it is directly evidenced by
`generate_meetings.py:102-108`.

---

## 9. The booking request/response state machine

### 9.1 What each repo actually evidences

| Repo | States | Line |
|---|---|---|
| pretix `Order.status` | `pending`, `paid`, `expired`, `canceled` (4) | `orders.py:196-206` |
| pretix `Order.require_approval` | orthogonal **boolean** | `orders.py:310-312` |
| pretix `Order.valid_if_pending` | orthogonal **boolean** | `orders.py:219-221` |
| pretix `Item.require_approval` | per-listing **boolean** | `items.py:619-625` |
| pretix `Quota` | `GONE / ORDERED / RESERVED / OK` (availability, *not* lifecycle) | `items.py:2046-2049` |
| rox `HostingRequest.status` | `OPEN / CANCELLED / DECLINED / TENTATIVELY_ACCEPTED / ACCEPTED` (5) | `HostingRequest.php:34-38` |
| rox `ReportToModerator` | `Open / OnDiscussion / Closed` | `ReportStatusType.php:6-9` |
| trustroots `Experience` | *no status* — one immutable row per pair | `experiences.server.model.js:12-63` |
| Medusa `TransactionState` | 7 (technical, not domain) | `utils/src/orchestration/types.ts:6-14` |
| Medusa `TransactionStepState` | 10 (technical) | `utils/src/orchestration/types.ts:16-27` |

**No repo has a complete booking-request lifecycle with a completed/attended state.**
rox's 5 states stop at `ACCEPTED`. pretix has `paid` but no `attended`. The `completed`
state in §9.2 is **INFERENCE**, borrowed conceptually from rox's `Log` entity
(`src/Entity/Log.php:35-53`: `Str`, `Type`, `created` — a hosting happened) and
trustroots' `interactions.met` (`experiences.server.model.js:31-40`).

### 9.2 The ATHITI state machine (synthesis)

**Orthogonal axes, following Medusa §4.8 and *not* rox §7.4:**

- `status` — the lifecycle (7 values).
- `requires_approval` — copied from the listing onto the request (pretix pattern,
  `orders.py:310-312`), so `auto_confirm` listings skip straight to `accepted`.
- `cancelled_by` — `'traveller' | 'provider' | 'system'`; distinguishes user-cancel from
  no-show. INFERENCE, from rox's `ReportToModerator.LastWhoSpoke` idea
  (`ReportToModerator.php:79-84`).

`canTransition()` is a whitelist; anything not listed throws. Modelled directly on
Medusa's `allowed` map (`transaction-step.ts:90-126`).

| # | From | To | Trigger | Capacity effect | Notification | Analytics | Evidenced? |
|---|---|---|---|---|---|---|---|
| 1 | — | `pending` | Traveller submits request | **HOLD**: `pending` joins the availability sum (`quotas.py:361-371`) | notify provider (in-app) | `request_created` | pretix `STATUS_PENDING` + cart-reservation analogue; rox `REQUEST_OPEN` |
| 2 | `pending` | `accepted` | **Provider** accepts (or auto-confirm if `requires_approval=false`) | hold → confirmed; still counted | notify traveller | `request_accepted` | pretix `STATUS_PAID` (transitions out of pending, `orders.py:1836-1837`); rox `REQUEST_ACCEPTED` |
| 3 | `pending` | `declined` | **Provider** declines | hold **released** | notify traveller | `request_declined` + reason | rox `REQUEST_DECLINED`; **no pretix analogue** |
| 4 | `pending` | `cancelled` | **Traveller** withdraws | hold released | notify provider | `request_cancelled` | pretix `STATUS_CANCELED`; rox `REQUEST_CANCELLED` |
| 5 | `pending` | `expired` | **System** (cron) when `expires_at < now()` | hold released | notify both | `request_expired` | pretix `STATUS_EXPIRED` (holds until `expires`, `orders.py:262-264`); rox *none* — INFERENCE |
| 6 | `accepted` | `cancelled` | **Traveller**, before `starts_at` | capacity **released** | notify provider | `refund/cancel` | pretix `allow_cancel` per-listing (`items.py:639-644`); rox *none* — INFERENCE |
| 7 | `accepted` | `completed` | **System**, after `ends_at` | capacity stays consumed | — | `review_prompt` | **INFERENCE** — no repo has this; justified by `trustroots` reviews being gated on a real interaction (`experiences.server.model.js:31-40`) |
| 8 | `completed` | — | (terminal) | — | — | revenue booked | INFERENCE |
| 9 | `declined` / `expired` / `cancelled` | — | (terminal) | — | — | funnel drop-off | pretix excludes these from the sum (`quotas.py:305`) |

**Legal transitions (whitelist):**

```typescript
const TRANSITIONS = {
  pending:   ["accepted", "declined", "cancelled", "expired"],
  accepted:  ["cancelled", "completed"],
  declined:  [],
  cancelled: [],
  expired:   [],
  completed: [],
} as const satisfies Record<RequestStatus, readonly RequestStatus[]>;

export function assertTransition(from: RequestStatus, to: RequestStatus) {
  if (!(TRANSITIONS[from] as readonly RequestStatus[]).includes(to)) {
    throw new IllegalTransitionError(from, to);
  }
}
```

**Who may trigger each transition** (INFERENCE, enforced in the route layer):

| To | `traveller` | `provider` | `system/cron` | `admin` |
|---|---|---|---|---|
| `pending` | ✅ create | — | — | — |
| `accepted` | — | ✅ | ✅ if `requires_approval=false` | ✅ |
| `declined` | — | ✅ | — | ✅ |
| `cancelled` | ✅ | ✅ | — | ✅ |
| `expired` | — | — | ✅ | — |
| `completed` | — | — | ✅ | ✅ |

**Three side-effect rules worth stating explicitly:**

1. **Capacity is released by leaving the sum, never by incrementing a counter.** The
   only thing that changes on a state transition is which bucket the `party_size` falls
   into. This is the pretix property from §1.1 and it is why there is no
   release-capacity bug to write. Transitions 3, 4, 5, 6 all just stop counting.
2. **`pending` holds capacity.** From `quotas.py:420-455` (carts) and
   `quotas.py:361-371` (pending orders). This is a product decision: it prevents
   providers from getting double-booked, and it means *a request is not free to make*.
   Mitigation: `expires_at` (transition 5) so abandoned requests free up.
3. **`declined` frees capacity immediately, which can cascade.** If a slot was held by
   3 pending requests for `capacity=1`, declining two of them should ideally auto-promote
   the third. pretix solves this with a **waiting list** whose promotion runs under
   the same lock — `domain/pretix/src/pretix/base/services/waitinglist.py:100-114`:

```python
    with transaction.atomic(durable=True):
        …
        lock_objects(quotas, shared_lock_objects=[event])
        for wle in qs:
```

…plus a voucher hand-out (`src/pretix/src/pretix/base/models/waitinglist.py:152-159`):

```python
    def send_voucher(self, quota_cache=None, user=None, auth=None):
        availability = (
            self.variation.check_quotas(count_waitinglist=False, subevent=self.subevent, _cache=quota_cache)
            if self.variation
            else self.item.check_quotas(count_waitinglist=False, subevent=self.subevent, _cache=quota_cache)
        )
        if availability[1] is None or availability[1] < 1:
            raise WaitingListException(_('This product is currently not available.'))
```

**ATHITI v1: skip the waiting list.** `pending` + `expires_at` gets you 80% of the
value. If you have time, add a one-line "3 others also requested this" counter
(`quotas.py:470-491` gives you the query).

### 9.3 Optionally: Medusa's technical states, mapped

If you *do* want durable execution for a multi-provider (payment + notification) booking,
Medusa's `TransactionState` maps like this (INFERENCE):

| Medusa | ATHITI booking |
|---|---|
| `NOT_STARTED` | request row created, no work done |
| `INVOKING` | capacity held, provider being notified |
| `WAITING_TO_COMPENSATE` | provider saw it and it's queued for a manual action |
| `COMPENSATING` | rolling back — capacity being released |
| `DONE` | `accepted` (or `completed`) |
| `REVERTED` | back to `pending` after a failed side effect |
| `FAILED` | `declined` / system error |

And the compensation chain for our booking would be, in Medusa step terms:
`holdCapacityStep` → `createNotificationStep` → `emitEventStep`, with
`holdCapacityStep` being the only one needing a `compensate` (release the hold) —
per `create-step.ts:184` (`stepConfig.noCompensation = !compensateFn`).

**For a 1-week build: use the 6-state domain machine in §9.2, not the Medusa engine.**

---

## 10. "Do we need this?" — hackathon verdict (2–4 people, 1 week)

### 10.1 The rank

| Rank | Mechanism | Effort | Demo value | Verdict |
|---|---|---|---|---|
| **1** | **`status` enum + `assertTransition()` whitelist (6 states)** | 2 h | 🔴 Essential — a "credible provider side" is a state machine, full stop | **BUILD** |
| **2** | **Provider inbox: pending requests, accept/decline in one tap** | 4 h | 🔴 **This IS the provider side.** Nothing else substitutes | **BUILD** |
| **3** | **Derived capacity (sum of non-terminal `party_size`), never a counter** | 2 h | 🔴 Prevents the #1 credibility failure (double-booking) | **BUILD** |
| **4** | **`pending` holds capacity + `expires_at` releases it** | 3 h | 🟠 Shows you understand the hard problem. 10 extra lines over #3 | **BUILD** |
| **5** | **Guarded `UPDATE ... WHERE status = 'pending'` inside a transaction** | 2 h | 🔴 Makes double-click / double-submit safe. ~15 lines | **BUILD** |
| **6** | **better-auth, 2 roles, Drizzle adapter, CLI-generated schema** | 6 h | 🟠 You need *some* auth. Don't hand-roll it | **BUILD** (use `additionalFields.role`, skip the org plugin) |
| **7** | **Listing editor: ~14 fields, one screen** | 6 h | 🔴 Providers must be able to publish or there's no marketplace | **BUILD** |
| **8** | **`occurrences` table (dated slots)** | 3 h | 🟠 Lets you demo "3 slots, 2 full" — the whole point of capacity | **BUILD** |
| **9** | **Idempotency-Key + unique column on the request** | 1 h | 🟠 Invisible until it saves you; cheap insurance | **BUILD** (30 min) |
| **10** | **In-app notification on each transition** | 3 h | 🟠 A badge count on the provider's inbox is the demo's "it works" beat | **BUILD** (in-app only) |
| **11** | **Booking timeline / activity log (`request_events` table)** | 3 h | 🟠 "Provider accepted 4h ago" — cheap trust, looks professional | **BUILD if time** |
| **12** | **Mutual reviews (`review` table, trustroots model)** | 4 h | 🟠 Closes the loop: reviews only after `completed` makes the whole loop feel real | **BUILD if time** |
| **13** | `booking_from` / `booking_until` window (pretix 3-layer clamp) | 2 h | 🟡 Nice, rarely demoed | skip → single `bookable_until` |
| **14** | `party_members` table (real per-person constraints) | 5 h | 🟠 **High demo payoff, high effort.** `party_size` int gets you 80% | **`party_size` int;** table only if you have a spare day |
| **15** | `alignment: aligned \| mixed \| conflicting` pre-seeded personas | 1 h | 🟠 **Best effort-to-payoff ratio in the whole list** (ai-tour-meeting:102-108) | **BUILD — 1 hour** |
| **16** | Waiting list + auto-promotion on decline | 5 h | 🟡 Impressive, not demoable in a 7-min pitch | **SKIP** |
| **17** | Availability Redis cache (pretix §1.5) | 6 h | 🟢 Zero. At demo scale the aggregate is sub-ms | **SKIP** |
| **18** | Medusa-style workflow engine / `workflow_execution` table | 3+ days | 🟡 Impressive, will eat your week | **SKIP.** Take the ideas (§4.12), not the code |
| **19** | Step compensation / saga | 1 day | 🟡 For a 1-step booking, compensation is just "set status back" | **SKIP.** Do it manually in the handler |
| **20** | `pg_advisory_xact_lock` + `lock_timeout` + retry | 3 h | 🟠 Correct, but only needed if you're on Postgres **and** expect concurrent writers. `#5` already covers you | **if Postgres**; on SQLite, skip |
| **21** | Vouchers / promo codes | 5 h | 🟢 Not core | **SKIP** |
| **22** | Deposits / partial payment | 1 day | 🟡 Providers like it, but it's a payments project | **SKIP** |
| **23** | Check-in / QR / attendance | 1 day | 🟡 Belongs to v2 | **SKIP** |
| **24** | Multi-currency + tax rules (pretix has ~4 files of it) | 1 day | 🟢 | **SKIP** |
| **25** | better-auth `organization` plugin (multi-staff providers) | 1 day | 🟡 | **SKIP** for v1 |
| **26** | Verification badges UI | 2 h | 🟡 Renders data from #6 + #12. Do it at the very end if time | **LAST** |
| **27** | Reporting / moderation queue (rox `ReportStatusType`) | 5 h | 🟡 Trustroots pairs it with reviews; standalone it's a support tool | **SKIP** unless reviews ship |
| **28** | `shadowban` / `welcome-team` / member status tiers | — | 🟢 Zero for a marketplace | **SKIP** |

### 10.2 The one-paragraph answer

**The only thing that makes a marketplace "credible" is a correct request/response loop
over a shared scarce resource.** That is ranks 1–5, and it is ~13 hours of work. pretix
spends 275 lines on capacity aggregation (`services/quotas.py`) and 134 on locking
(`services/locking.py`) because it has 20 years of carts, vouchers, waiting lists,
seats, multi-currency, tax rules, check-in and invoicing behind it. **You have none of
those, so your capacity code is one `SUM() GROUP BY` and your locking is one conditional
`UPDATE`.**

Concretely, the pretix lesson that matters is §1.1: **derive availability by aggregation,
never store a counter.** One `SUM(party_size) WHERE status IN ('pending','accepted')`
gives you correct "3 of 5 spots left" with *zero* release logic, *zero* reconciliation,
and *zero* drift bugs. The lesson that matters second is §2.2: **lock before you
re-count** — the order is lock → re-read → assert → write, all in one transaction.

Everything else in this report is gold-plating for a 1-week build. Medusa's workflow
engine (#18) is the most tempting and the most dangerous: it is genuinely well designed
(`state` × `status` orthogonal axes at `utils/src/orchestration/types.ts:16-35`, an
enforced transition table at `transaction/transaction-step.ts:90-126`, a
durable-execution table at `modules/workflow-engine-inmemory/src/models/workflow-execution.ts:4-58`),
and it will consume your entire week. **Steal the two-axis design and the transition
whitelist. Write neither the engine nor the execution table.**

And the highest-leverage hour in the whole build is #15: pre-seed three travellers with
`alignment: 'conflicting'` — "slow immersive pace vs. packed itinerary", "strict low
budget vs. upscale", "early start vs. late night", straight out of
`systems/ai-tour-meeting/tour_meeting/generate_meetings.py:102-108` — so the provider
inbox shows a group, not a name. That one field turns a booking demo into a *group
travel* demo, and it costs an hour.

### 10.3 Suggested 5-day split (3 people)

| Day | Person A (core) | Person B (provider side) | Person C (traveller side + polish) |
|---|---|---|---|
| 1 | Drizzle schema: `user`(better-auth) + `listing` + `occurrence` | better-auth setup, `role` field, CLI-generate | Seed script: 3 providers, 12 listings, 30 occurrences |
| 2 | `request` table, `assertTransition`, guarded-update transition fn | Provider inbox list + accept/decline endpoints | Listing editor form (14 fields) + publish flow |
| 3 | Capacity sum, `pending` hold, `expires_at` cron, `Idempotency-Key` | Notifications + `request_events` timeline | Traveller browse → detail → request flow |
| 4 | Reviews + `completed` state + "request again" | `party_size` + pre-seeded conflicting personas | Auth flow polish, empty/loading states |
| 5 | Integration, seed a full story, fix | Seed + screenshot the inbox | Seed + screenshot the listing |

