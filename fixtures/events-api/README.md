# Events API contract fixtures

Provenance is labeled per file via the `_fixture` key (adapter tests must strip keys starting with `_`).

- `event.live-observed.json`, `error.401.json`: observed anonymously from api.awsevents.com during the spike.
- `sessions.page-*.json`, `error.429.json`: SYNTHETIC, derived from the OpenAPI spec. Not live data. Real session responses need an attendee bearer token, which this spike did not have.

Pagination sequence: page-1 (2 items, nextToken) -> page-2 (2 items, nextToken) -> page-3 (1 item, no nextToken). Pages are deliberately short (max page size is 250) so tests must follow `nextToken`, not page size. `page-empty-final` covers an empty last page. `SYN-0003` has only required fields.
