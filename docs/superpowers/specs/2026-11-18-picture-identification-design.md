# Picture identification: design

Date: 2026-11-18. Status: approved by the user on 2026-11-18.

## Intent

Title rules will never cover every way a seller words a title. A wrong card number sends someone a
false DM, which is worse than a miss. The image model is already loaded and every card has a
reference picture, so the bot can ask "which card is this picture?" across all references, not
only "is this picture card N?". The answer then backs the title's number, contradicts it, or
stands in for a number the title lacks.

## Measurement (2026-11-18)

The test set was 164 eBay single-card listings whose title gives the card number beyond doubt.
Each listing picture was compared with all 251 sammel-ente reference pictures, using the model
`Xenova/dinov2-small`.

- The best match was the right card in 153 of 164 cases (93 %).
- "Decided" means the best match is at least 0.78 and leads the second-best by at least 0.02.
  Under that rule, 143 of 164 were decided (87 %) and none was wrong.
- The misses are mostly puzzle cards (#154–#184: "Der Nether", "Oberwelt", "Das Ende"). These are
  pieces of one big picture and look alike. All of them stayed below 0.78.
- Caveat: many of the listings came from one seller with uniform photos. Phone photos will decide
  less often. Recheck after a few weeks of real data.

## Rules

These apply to single-card listings of every shop except sammel-ente (eBay, blue-ocean,
collect-it).

1. **Title number = best picture match, and decided.** The status is `confirmed`, and the alert
   shows "✅ picture matches".
2. **Title number ≠ best picture match, and decided.** The listing is not sent to users. It gets a
   new status, `mismatch`, holding both numbers. The admin gets a throttled note per listing
   (title number, picture number, link) and can fix it with `/admin map`. A rescrape with a
   changed picture or title compares it again.
3. **Not decided.** Today's behaviour applies: the comparison with the title number's own
   reference gives `confirmed` or `unconfirmed`.
4. **No number in the title (eBay only).** A listing counts as a candidate when all of these hold:
   - its title passes the series 3 check;
   - it is not excluded (series 1 or 2, multi-pick, range, variations);
   - it contains no product or count word (pack, booster, blister, lot, …).

   The picture alone decides, and only when decided under the rule above. Such a listing is
   stored with the picture's number and the status `confirmed`. The alert says "number from the
   picture" and shows the reference picture beside it. An undecided candidate is dropped, as
   today.

5. **Puzzle cards are never identified by picture alone.** In rules 2 and 4, a best match that is
   a puzzle card does not count as decided. Rule 1 can still confirm a puzzle card whose title
   names it.

## Notes for the build

- Reference embeddings are cached (the embedding cache exists). Comparing one picture with 251
  references is a dot product per reference, which is cheap. Only listings that need a match
  (new or changed) are compared, so cost stays low.
- Which cards are puzzle cards comes from the card type in collect-it or sammel-ente titles
  ("Puzzlekarte"). The builder picks the source from the fixtures. Hard-coding a number range is
  not allowed.
- Bundles stay as they are, never compared.
- `docs/image-matching.md` records the measurement and the rules.

## Decided by the user

- Build the picture identification now, before the status table and `/stock`/`/card`.
- Follow the rules for title-and-picture agreement, mismatch, and the picture alone, with puzzle
  cards excluded from picture-only identification.

## Calls made by Claude (please check)

- A mismatch is held back from users and reported to the admin. It is never re-mapped
  automatically to the picture's number.
- Picture-only identification (rule 4) applies to eBay only. The other shops' titles always carry
  a number.
- Candidates for rule 4 exclude any title with a product or count word, so a blister photo
  showing an LE card is never read as that LE card.
- The admin note for a mismatch is throttled per listing, like the other admin alerts.
