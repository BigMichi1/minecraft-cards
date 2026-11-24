# Image matching

The image check is a safety net: it compares a shop listing's picture with the reference
picture of the same card number and marks the listing `confirmed` when the cosine similarity of
their embeddings reaches `IMAGE_MATCH_THRESHOLD`. Code: `src/bot/matcher/embedder.ts`,
`src/bot/matcher/imageInput.ts`.

## Reference pictures

`catalogManager.referenceCatalog` chooses one reference per card, by the card's source (multi-
collection step 2, measured in "Measurement on laststicker scans" below):

- **A laststicker card**: its laststicker scan (`/i/cards/<set id>/<id>.jpg`, stored by the
  catalog sync). The collection's `referenceFallbackShop` (sammel-ente for series 3) gives the
  fallback: the newest picture of that shop's listing of the card.
- **A scan that answers 404 or 410** (laststicker has none: 17 series 3 cards on 2026-11-24,
  LE3 to LE12, LE16 to LE19, LE21, LE22, XXL1): the reference loader embeds the fallback in the
  same run and records the miss (`laststicker_scan_missing_at`). The shop picture is the
  reference for 7 days (`SCAN_RETRY_MS`), then the scan is tried again; a sync storing another
  scan URL clears the mark. Any other failure of a scan (5xx, timeout, network) never falls
  back: it is `image_unavailable`, retried once a day.
- **A manual card** (`/admin catalog add|edit`): the admin's picture, else the shop picture.
- No picture at all: `no_picture`, the card's listings are `no_reference`.

A card whose chosen reference changes has its mismatches compared again: a new or changed scan
(sync), a shop picture in use that changed (sammel-ente's run), a scan that answers 404 or 410
for the first time, a scan that loads again after its 7 days, a manual card's new picture and a
release. A first missing scan is recorded only after its card's mismatches were put back, and a
returning scan's record is cleared only after that, so a failure is tried again next run; a scan
that answers 404 again after its 7 days changes nothing. Missing scans are named in a throttled
admin alert per list of cards (`scan-missing:<collection>:<cards>`), with the cards left without
any reference and the ones that could not be recorded. Every picture download from laststicker
(scans for matching, thumbnails in DMs and `/card`) goes through one pacer: at most one request
per 1500 ms (`pacedImageFetch`); the set pages keep the sync's own 1500 ms. The embeddings are
cached by URL, so each scan is downloaded once; the first run after the switch requests all 251
scans (234 load), about 6 minutes before its DMs.

sammel-ente's listings are compared like every other shop's.

**Re-matching.** Migration 0008 set every listing the admin had not mapped and that is no bundle
back to `pending`, keeping its old status when it was a judgement (`rematch_from`). Every later
reset of a mismatch (a changed reference, above) marks it the same way (`rematch_from`
`mismatch`). Such a listing is held back from users until it is compared again with a final
status (`no_reference` and the unavailable statuses are retried, not final); `/stock`,
`/missing status` and `/card` show it as held back. A final status, an admin map or a bundle ends
its re-match. Each run counts the ones it compared again: when any changed status or is a
mismatch, the admin gets one summary (`Re-match against new reference pictures: compared N
listing(s) again, M changed.`, every mismatch named first with its picture card, then up to 10
other changes) instead of a note per mismatch, and `/admin run` shows `Re-match: N compared, M
changed`. A mismatch the summary has no room for, or a summary that cannot be delivered, keeps
its own note. Notifications stay recorded per listing and availability period, so nobody is
notified twice.

## Defaults

| Setting                 | Default               |
| ----------------------- | --------------------- |
| `IMAGE_MODEL`           | `Xenova/dinov2-small` |
| `IMAGE_MATCH_THRESHOLD` | `0.78`                |
| `MODEL_CACHE_DIR`       | `./models`            |

`./bin/mise run model:download` fetches `IMAGE_MODEL` into `MODEL_CACHE_DIR` once (85 MB
for DINOv2-small); the directory is gitignored.

## Measurement (2026-11-17)

`./bin/mise run measure:threshold` reads every page of both shops, keeps the blue-ocean
series 3 listings ("On Fire" in the title), and pairs them with sammel-ente by card id:

- **true pairs**: blue-ocean card _n_ against sammel-ente card _n_;
- **false pairs**: blue-ocean card _n_ against the sammel-ente card of the next card id both
  shops have, in sorted order (usually _n + 1_; the last one wraps to the first).
  Neighbouring cards are often parts of one panorama, so this is the hard case.

251 sammel-ente listings, 206 blue-ocean series 3 listings (456 in total), 203 shared card
ids, so 203 true and 203 false pairs.

| Model                          | True min | True median | True max | False min | False median | False max |
| ------------------------------ | -------- | ----------- | -------- | --------- | ------------ | --------- |
| `Xenova/clip-vit-base-patch32` | 0.7022   | 0.8552      | 0.9204   | 0.5303    | 0.7524       | 0.8563    |
| `Xenova/dinov2-small`          | 0.6650   | 0.8852      | 0.9508   | 0.2625    | 0.5742       | 0.8020    |

Neither model separates the groups completely: the gap (true min − false max) is −0.1541
for CLIP and −0.1369 for DINOv2. Errors at the candidate thresholds:

| Model  | Threshold             | True pairs unconfirmed | False pairs confirmed |
| ------ | --------------------- | ---------------------- | --------------------- |
| CLIP   | 0.7792 (midpoint)     | 9 / 203                | 56 / 203              |
| CLIP   | 0.8069 (fewest errs.) | 22 / 203               | 24 / 203              |
| DINOv2 | 0.7335 (midpoint)     | 1 / 203                | 15 / 203              |
| DINOv2 | 0.7772 (fewest errs.) | 4 / 203                | 6 / 203               |

Worst pairs for DINOv2: lowest true 123 = 0.6650, 80 = 0.7441, 166 = 0.7459; highest false
201~202 = 0.8020, 158~159 = 0.7939, 17~18 = 0.7908. For CLIP: lowest true 58 = 0.7022,
31 = 0.7119, 78 = 0.7246; highest false 110~111 = 0.8563, 155~156 = 0.8469, 87~88 = 0.8456.

**Choice:** DINOv2-small has the wider (less negative) gap and far fewer errors. Because the
groups overlap, a gap midpoint is not a separating threshold; the default is the
fewest-errors point 0.7772, rounded to 0.78. The error rates were measured at 0.7772: 4 of
203 genuine matches (about 2 %) show as unconfirmed and 6 of 203 neighbouring-card mix-ups
(about 3 %) would still be confirmed. The rounded 0.78 was not re-measured (the measurement
needs the live shops); a pair scoring between 0.7772 and 0.78 counts as unconfirmed there,
so at 0.78 the first rate can only be the same or higher and the second the same or lower.
`confirmed` is strong evidence, not proof.

Measured with transformers.js 4.3.2 on CPU; embedding two shop images (download included) took about 0.5 s.

### Embedding details

- CLIP's ONNX export returns `image_embeds` (the projected pooled vector); DINOv2's returns
  only `last_hidden_state`, whose CLS token is what DINOv2's pooler returns. The
  pipeline's own `pool: true` option needs a `pooler_output` that neither has, so the
  embedder calls the processor and model itself and picks `pooler_output`, `image_embeds`,
  or the CLS token, then L2-normalises.
- **sharp does not work under Bun 1.4.4**: every sharp operation (decode, resize, even
  `sharp({ create })`) never settles, and the process exits or hangs. transformers.js uses
  sharp for decoding, resizing and cropping in Node-like runtimes, so the embedder decodes
  and resizes with `Bun.Image`, re-encodes to PNG, decodes that with a small PNG reader,
  center-crops in JS, and turns the processor's own resize and crop off. The processor
  still converts to RGB, rescales and normalises.

## collect-it.de pictures (2026-11-18)

A spot check with the default model (`Xenova/dinov2-small`) on 40 collect-it listings: each listing's picture was compared with the sammel-ente reference of the same card (true pair), and with the reference of the next card (false pair).

| Pairs      | min   | median | max   | at or above 0.78 |
| ---------- | ----- | ------ | ----- | ---------------- |
| same card  | 0.729 | 0.847  | 0.930 | 38 of 40         |
| other card | 0.145 | 0.534  | 0.814 | 2 of 40          |

At 0.78, 2 of 40 wrong-card pairs (5 %; blue-ocean 6 of 203, about 3 %) would show as "picture
matches", and 2 of 40 genuine matches (5 %; blue-ocean 4 of 203, about 2 %) would show as
unconfirmed. Both rates are small, and measured on only 40 pairs, so the threshold stays at 0.78.
The alert shows the listing picture, so the user can still spot a wrong card.

## Picture identification (2026-11-18)

The comparison above asks "is this picture card N?". Title rules never cover every way a
seller words a title, and a wrong number sends a false DM, so the matcher also asks "which card
is this picture?" across all references (`src/bot/matcher/identify.ts`, `matchListing` in
`embedder.ts`). The answer backs the title's number, contradicts it, or stands in for a number
the title lacks. Design: `docs/superpowers/specs/2026-11-18-picture-identification-design.md`.

### Measurement

164 eBay single-card listings whose title gives the card number beyond doubt ("Karten N - Name

- Typkarte Serie 3", "LE N"), each picture compared with all 251 sammel-ente references, model
  `Xenova/dinov2-small`:

- the best match was the right card in 153 of 164 (93 %);
- **decided** means the best match reaches `IMAGE_MATCH_THRESHOLD` (0.78) and leads the
  second-best by at least `DECISION_GAP` (0.02): 143 of 164 decided (87 %), none wrong;
- the misses are mostly puzzle cards (#154–#189, "Oberwelt", "Unter der Erde", "Der Nether",
  "Das Ende"): pieces of one big picture that look alike; all stayed below 0.78;
- caveat: many listings came from one seller with uniform photos. Phone photos will decide
  less often; recheck after a few weeks of real data.

Of the 143 decided, 100 also had the second-best below 0.78; requiring that as well would have
cost 43 decisions without preventing any error, so it is not a rule.

**Twins.** Two references at least `TWIN_SIMILARITY` (0.9) alike show the same art, and the
picture cannot tell those cards apart. Over the 251 references on 2026-11-18: #59 and XXL1
(Charged Creeper) 0.945 (LE10 and LE11 showed 1.0, but that is one placeholder picture, see
below); the next most alike pair 0.866 (LE5 and LE13). Both the threshold, the gap and the twin
bar are met within `SIMILARITY_EPSILON` (1e-6), since float32 embeddings put an exact value a
few 1e-8 below it. The live check found collect-it's #59 decided as
XXL1 (0.885 against 0.853 for #59), which the twin rule and the title-card rule below keep from
being a mismatch.

**Placeholder references.** sammel-ente shows the empty card `mnc3_leer.jpg` for cards it has
no picture of yet (LE10 and LE11 on 2026-11-18). A placeholder tells no card apart, so a
reference whose file name contains `_leer.`, or a picture (URL without its query, `?ts=`
changes on every upload) that sammel-ente shows for more than one card, counts as no reference
at all (`catalogManager.referenceCatalog`): the card's listings are `no_reference` (retried
every check until a real picture arrives), the card is left out of the identification, so no
picture is ever identified as it, and no alert shows the placeholder as its thumbnail. Each
run that compares pictures names these cards in one warning.

**Only the complete reference set decides.** A card missing from the comparison could be the
true one, and the gap to the runner-up would then look fine for a wrong card (a photo of LE10
decided as LE5). So the picture may decide a card other than the title's (rules 2 and 4) only
when every card of the listing's collection has a loaded, usable reference. Narrowing that to the card's kind (base,
LE, XXL) does not hold: on 2026-11-18, 39 of 475 live listing pictures (eBay and collect-it)
reached 0.78 against a reference of another kind than their own, and for 5 of them that
reference was the best match. With LE10 and LE11 on the placeholder, rules 2 and 4 are
therefore off until sammel-ente shows their real pictures; rules 1 and 3 work as before.

**A reference that fails to load** (network, host, size, decoding, or the model failing on that
one picture) leaves the set incomplete for the run. A listing that would then end as anything
but `confirmed` gets `image_unavailable` (or `model_unavailable` when the model fails on every
reference) instead, so it is compared again with the full set: never a final `unconfirmed`,
`mismatch` or picture-only card. The bot tries a failed reference again at most once a day
(`referenceFailures`, kept for the process), and sends one throttled admin alert per collection
(`reference-unavailable:<collection>`) naming the collection, cards, reasons and picture URLs. References load four at a
time.

### Rules

For single-card listings of every shop (bundles are never compared):

1. **The picture decides the title card.** `confirmed`; the alert shows "✅ picture matches
   reference". This also confirms a puzzle or twin card the title names.
2. **The picture decides another card, and the title card's own reference stays below the
   threshold.** `mismatch`, holding the picture's card in `listings.picture_card_id`. Never sent
   to users; the admin gets a note with both numbers and the link, and fixes it with
   `/admin map`. The note is durable (`listings.mismatch_noted_at`): one that fails to send goes
   out in a later run. It is throttled per listing and picture card (key
   `mismatch:<listing id>:<card>`): the same mismatch found again within a day sends nothing
   new, another picture card or a day later does. A rescrape with a changed picture or title
   compares it again, and so does a changed reference picture of either card. A mismatch is never re-mapped to
   the picture's number automatically. A picture that also reaches the title card's reference
   does not contradict the title (some cards share their art), so rule 3 applies.
3. **The picture decides nothing.** Today's comparison with the title card's reference gives
   `confirmed` or `unconfirmed`.
4. **No number in the title (eBay only).** A title is a candidate when it passes the series 3
   check, is not excluded (series 1 or 2, pick list, range, variations), has no `COUNT_WORDS`
   word (pack, booster, blister, lot, Karten, Holo, Stück, …) and no number but the series and a
   year (`isPictureCandidate` in `shops/ebay.ts`). The adapter passes it on with no card ids and
   `idSource: 'picture'`. A decided picture gives it that card (`confirmed`); the alert says
   "🖼️ number from the picture" and shows the reference beside the listing picture. An
   undecided candidate is stored without card ids (`unconfirmed`), so it is never notified, and
   is compared again when its picture or title changes, or when any reference picture changes.
5. **Puzzle cards and twins are never identified by the picture alone.** In rules 2 and 4 a
   best match that is a puzzle card or has a twin does not count as decided.

An admin-mapped listing (`/admin map`) is never compared or identified again.

**One-click confirmation.** A single-card `unconfirmed` alert carries a "✅ Right #<card>" button.
A user's click DMs the admin the listing with a "✅ Confirm" button, at most once a day per
listing (throttle `confirm-request:<listing>`, released when the DM fails); it puts no hold on the
listing and files no report, and a listing that is no longer `unconfirmed` sends nothing. The
admin's "⚠️ Wrong card reported" DM carries "✅ Confirm" and "🗑️ Dismiss". Confirm is
`/admin map` with the listing's current cards (admin-mapped from then on), except that it keeps
`availableSince`, so nobody who had the alert is notified again. It is refused, naming the
reason, when the cards or the picture URL (a fingerprint in the button,
`interactions/buttonIds.ts`) changed since the DM, or when the listing is a `mismatch` or
`pending` (`isConfirmable`): a confirmation is never compared again. Dismiss is `/admin clear`.
Only the admin can press either. Both admin DMs attach the listing picture and the usable
reference (never a placeholder) as user alerts do (`withPictures` in
`interactions/adminActions.ts`); a DM Discord refuses as a bad payload (400/413, never 50007) is
resent once without them, any other failure is not resent, and these fallbacks are only logged,
not the `notify-pictures` alert.

**Puzzle cards** come from data: the rows laststicker lists under the section `Puzzlekarten`
(the catalog sync sets `cards.puzzle_seen`, never cleared, so a rename cannot drop the mark).
A row with a piece marker (`<div class="pz">`) counts too, should the section be renamed. Before
laststicker, sammel-ente's names said so ("#154 Puzzlekarte Oberwelt 1"); migration 0006 set
`puzzle_seen` on every card whose stored name contained "Puzzlekarte", since laststicker names
them by picture and piece ("The Overworld 1"). On 2026-11-18 and 2026-11-24 that gave the same 36 cards (#154–#189), the
set of collect-it's "Puzzlekarte" titles too.

**Counts.** Each run counts the picture decisions (`decided`) and, per reason, the ones that
did not count (`undecided`, `puzzle`, `twin`, `incomplete`, `title_fits`); `/admin run` shows
them as `Pictures: 3 decided · not counted: …`.

**Rows from before this release.** Migration `0003` sets every stored listing that is not
admin-mapped, a bundle or a reference back to `pending`, so all of them go through the new
rules on the next run. That is safe: the next run matches them before it sends anything, and a
notification is recorded per listing and availability period, so nobody is notified twice.

**Errors.** Any other error while matching one listing (the embedding cache's database, a bug)
is logged, leaves that listing as it was (retried next run) and sends one throttled admin alert
(`match-error`); the other listings are still matched and notified.

**Why a candidate needs no number at all:** a number the id patterns do not read is a count as
often as a card. The fixture title "lego© MINECRAFT 6 TradingCards ON FIRE incl. 1 special
Card" is a lot of six; "TradingCards" is glued together, so no count word catches it.

**Cost.** The references are embedded once per run on first use, through the embedding cache
(after the first run a database read each), and only when a listing needs a match (new, changed,
or retried). Comparing one picture with 251 references is 251 dot products of 384 values.

### Live check (2026-11-18)

Live eBay API through the adapter, live collect-it and blue-ocean, 251 live sammel-ente
references (249 usable: LE10 and LE11 are placeholders). The numbers were the same before the
review fixes (all 251 references, LE10/LE11 included) and after them, and also when the two
placeholders are left out of the catalog (a complete set):

| Shop       | Listings | Confirmed (rule 1) | Confirmed (rule 3) | Unconfirmed | Mismatch | Picture-only (decided / undecided) |
| ---------- | -------- | ------------------ | ------------------ | ----------- | -------- | ---------------------------------- |
| eBay       | 246      | 215                | 2                  | 27          | 0        | 0 / 2                              |
| collect-it | 233      | 188                | 7                  | 38          | 0        | –                                  |
| blue-ocean | 3        | 3                  | 0                  | 0           | 0        | –                                  |

The two eBay candidates stayed undecided: "LEGO Minecraft On Fire (2026)" (best #214 at 0.518)
and "Lego Minecraft Karte Serie 3 Chast Ultra Rare" (best #131 Ghast at 0.644, right but below
0.78). The only other-card decision was collect-it #59 against XXL1 (twins, above). Rejected
decisions after the fixes: eBay 31 undecided; collect-it 44 undecided, 1 twin.

## Measurement on laststicker scans (2026-11-24)

Before laststicker's scans became the references (multi-collection step 2),
`./bin/mise run measure:laststicker` compared them with the shop pictures of series 3, model
`Xenova/dinov2-small`, the bot's values (`IMAGE_MATCH_THRESHOLD` 0.78, `DECISION_GAP` 0.02,
`TWIN_SIMILARITY` 0.9):

- **true pairs**: a single-card listing of card _n_ (title naming one card) against scan _n_;
- **false pairs**: the same picture against the scan of the next card id that shop has;
- **identification**: every picture against all scans (`identifyPicture`, rules 1 to 5 input).

laststicker lists 251 cards; 17 scans answer 404 (LE3 to LE12, LE16 to LE19, LE21, LE22,
XXL1), so 234 scans loaded. Those 17 cards keep the sammel-ente picture as their reference
(`referenceFallbackShop`).

| Shop        | Pairs | True min | True median | False max | Missed at 0.78 | Wrong at 0.78 | Decided | Wrong decisions |
| ----------- | ----- | -------- | ----------- | --------- | -------------- | ------------- | ------- | --------------- |
| sammel-ente | 234   | 0.510    | 0.900       | 0.796     | 19 (8 %)       | 4 (1.7 %)     | 215     | 0               |
| collect-it  | 226   | 0.530    | 0.904       | 0.866     | 19 (8 %)       | 11 (4.9 %)    | 205     | 0               |
| eBay        | 216   | 0.479    | 0.966       | 0.843     | 27 (13 %)      | 9 (4.2 %)     | 189     | 0               |

- The wrong-card rate at 0.78 stays within what the earlier measurements accepted (blue-ocean
  3 %, collect-it 5 %), and the identification made no wrong decision in 676 pictures (609
  decided). No two scans are twins (none at 0.9 or more; XXL1, #59's twin, has no scan).
- More true pairs stay below 0.78 than against sammel-ente's pictures (2 % in 2026-11-17): the
  lowest are the set cards #192 to #207 (laststicker's scan differs from the shops' picture of
  them), puzzle card #172 and the ultra and foil cards #8 and #87. They are alerted marked
  "number unconfirmed", never sent as another card.
- The fewest-errors points differ per shop (0.788, 0.799, 0.854). For collect-it and eBay they
  buy fewer wrong pairs only with more missed ones; for sammel-ente 0.788 drops 3 wrong pairs at
  no cost, but no single value is better for all three. So the values stay: 0.78, 0.02 and 0.9.

**Run again on the production set** (the scans plus sammel-ente's pictures for the 17 cards
without one, as `referenceCatalog` chooses them; the first run left those 17 out). For those 17,
sammel-ente's "true pair" is its own picture against itself (1.0); collect-it lost 3 pictures
(LE1, LE2, LE5) to timeouts, hence 228 pairs. The rates
stay alike (wrong pairs at 0.78: sammel-ente 9 of 251, of them LE10~LE11 at 1.0, one shared
picture, which the shared-picture rule keeps from being a reference; collect-it 11 of 228; eBay
10 of 222), collect-it and eBay made no wrong decision (203 and 190 decided), and sammel-ente one
of 228: its #59 picture was decided as XXL1 (0.945). laststicker's #59 scan and sammel-ente's
XXL1 picture score below `TWIN_SIMILARITY`, so the twin rule no longer saw the pair. They show the
same art, so the collection names them (`knownTwins: [['59', 'XXL1']]`): a known twin is a twin
whatever its pictures score, and its picture alone never decides another card (rule 2 and 4).

### Series 1 (2026-11-24)

`./bin/mise run measure:laststicker -- --collection lego-minecraft-1`, same method and values:
laststicker lists 283 cards; 22 scans answer 404 (#157 to #162 and #165 to #180, the puzzle
cards), so 261 load and those 22 use sammel-ente's picture.

| Shop        | Pairs | True min | True median | False max | Missed at 0.78 | Wrong at 0.78 | Decided | Wrong decisions |
| ----------- | ----- | -------- | ----------- | --------- | -------------- | ------------- | ------- | --------------- |
| sammel-ente | 283   | 0.691    | 0.920       | 0.824     | 11 (4 %)       | 7 (2.5 %)     | 267     | 0               |
| collect-it  | 256   | 0.434    | 0.897       | 0.836     | 13 (5 %)       | 7 (2.7 %)     | 243     | 3               |

- The 3 wrong decisions (collect-it #154, #155, #156 decided as #157, #158, #159) are puzzle cards:
  rule 5 never takes a puzzle card from the picture alone, so none becomes a card or a mismatch.
- Twins by similarity: #84 and XXL1 (0.982), #108 and XXL2 (0.961), #109 and #152 (0.923); the
  twin rule covers them, so series 1 needs no `knownTwins`.
- The values stay (0.78, 0.02, 0.9) and series 1 keeps its scans.

## Data quality finding

The blue-ocean category also lists series 1 and 2 cards (titles "LEGO Minecraft TCC 1 …",
URLs ending `-tcc-1`). Card ids come from the URL suffix, so those listings would get a
card id too (for example `1` from `…-tcc-1`) that is not the series 3 card of that number;
in the measurement 250 of 456 blue-ocean listings were such cards. The blue-ocean parser
drops them by title (`isOnFireCardTitle`: the title must contain "LEGO Minecraft TCC" and
"On Fire"), and the measurement script reads blue-ocean through it.

## Compiled binary (`bun build --compile`)

Spike: a script that embeds one image, built with `bun build --compile` and run.

- **Plain `bun build --compile`: does not work.** The binary fails at startup with
  `Could not load the "sharp" module using the linux-x64 runtime`: transformers.js imports
  sharp at module load, and sharp's native addon cannot find its `libvips` next to it once
  embedded. Even unused, sharp must load.
- With a build plugin that (1) replaces `sharp` by a stub function, (2) rewrites
  transformers.js's `createRequire(...)("onnxruntime-node")` and onnxruntime-node's
  template-literal `require` of its `.node` binding into static requires, the binary gets
  as far as `libonnxruntime.so.1: cannot open shared object file`. With
  `LD_LIBRARY_PATH` pointing at `node_modules/onnxruntime-node/bin/napi-v6/linux/x64` it
  embeds the image correctly (512-dim with the CLIP model the spike used; DINOv2-small gives
  384), norm 1.0000, also from another working directory.

So a compiled binary is possible only with a custom `Bun.build` plugin plus shipping
`libonnxruntime.so.1` beside it. The Docker image therefore runs `bun run src/bot/bot.ts`
with the source and `node_modules` in the image, which needs none of that.

## Input limits

Remote pictures are bounded before they reach the model: downloads over 10 MB are refused
(declared `Content-Length` up front, streamed bodies as soon as they pass the cap), and
pictures over 10000 px on a side or more elongated than 10:1 are refused from their header,
before decoding or resizing. Pictures are fetched only over https from the shop and eBay
image hosts (`shop-sammel-ente.de`, `cdn.blue-ocean.de`, `www.blue-ocean.de`,
`www.collect-it.de`, `i.ebayimg.com`, and laststicker's scans on `www.laststicker.com`); redirects are followed by hand, at most 3, and only to those hosts.

## Alerts: layout and pictures

A user with at most 5 pending listings in a check (`SINGLE_MESSAGE_LIMIT` in
`src/bot/notify/messages.ts`) gets one DM per listing, each with its embed, picture and its
own button row directly under it. More listings are batched 5 per message; Discord shows all
button rows below all embeds, so each embed and its row carry the same position marker. At most
25 listings go out per user and check; the rest follow in the next checks. Each message is
recorded as sent only once Discord accepted it.

The alert DM does not link the listing picture and the reference thumbnail; the bot downloads
them with the same bounded download (`downloadImage` in `embedder.ts`: allowed hosts, timeout,
User-Agent, here capped at 2 MB per picture while downloading) and attaches them, and the embed
points at `attachment://picture-<n>.<ext>` or `attachment://reference-<n>.<ext>` (n is the
embed's position, the extension comes from the file's first bytes). Discord's media proxy shows
no collect-it.de pictures, most likely because the shop blocks datacenter IPs. A message's
downloads run in parallel. One check keeps the bytes of reference thumbnails only, so a shared
reference is downloaded once; a listing picture keeps only a failure, so a failing picture is
not retried within the check, and no listing bytes are kept after their message. Nothing is downloaded while the bot shuts down.

A picture on another host, a failed download, a file that is not JPEG / PNG / GIF / WebP, more
than 10 attachments or more than 8 MB per message keep the URL (`src/bot/notify/pictures.ts`),
so an alert is never lost because of a picture. Each of these is logged at warn (host not
allowed, attachment limit and byte budget once per check). The admin gets a throttled alert
(`notify-pictures`) naming the hosts and reasons when, in one check, at least 2 pictures fell
back (`MIN_FALLBACKS_FOR_ALERT`) and either more than half of the pictures fell back or every
picture of a host did; the attachment limit and the byte budget do
not count toward it. If Discord rejects a message with pictures as a bad payload (HTTP 400 or
413 other than closed DMs, e.g. 40005, 50035, 50045), the sender logs it, alerts the admin
(`notify-attachment-rejected`) and sends the message once more without pictures; it is recorded
as sent only if that send succeeds. Other errors (5xx, network, closed DMs, shutdown) are
handled as before.

## Match statuses

| Status              | Meaning                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`           | Not compared yet: a new single-card listing of any shop, or one whose picture, cards or id conflict changed (or title, for a mismatch or a title naming no card) |
| `confirmed`         | Picture matches the reference, the picture decided the card of an eBay title naming none, or the admin mapped it (`/admin map`)                                  |
| `unconfirmed`       | Below the threshold, a blue-ocean id conflict, or no picture to compare; a title naming no card whose picture decided nothing                                    |
| `mismatch`          | The picture decides another card than the title names; never sent to users, one admin note per listing                                                           |
| `bundle`            | Several cards in one listing; not compared                                                                                                                       |
| `no_reference`      | The card has no reference picture yet, or only a placeholder (`_leer.`, one picture for several cards); retried every check                                      |
| `model_unavailable` | No image model loaded, or the model failed on the picture; retried every check                                                                                   |
| `image_unavailable` | A picture could not be loaded (network, host, redirect, HTTP, size, decoding); retried once a day                                                                |

Only available listings of cards someone wants, and eBay titles naming no card, are compared.
`image_unavailable` and `model_unavailable` also mark a listing compared while a reference
picture failed to load (retried as above).
An admin-mapped listing stays `confirmed` when its picture changes later. Any other error while matching (the embedding
cache's database, a bug) fails the check run instead of being taken for a model problem.
