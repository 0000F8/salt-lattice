# Lattice schema

Generated from `crates/lattice-core/src/schema.rs` by the `schema_doc_is_fresh` test. Do not hand-edit; run:

```text
UPDATE_SCHEMA_DOC=1 cargo test -p lattice-core schema_doc_is_fresh
```

Schema version: **1**

## identity

| Type | Parent | Fields |
| --- | --- | --- |
| `identity.person` | — | name: text (required); birthday: date; pronouns: text; languages: text; note: text |
| `identity.location` | — | name: text (required); kind: enum(home\|work\|other) (required); city: text; country: text; note: text |
| `identity.contact_channel` | — | name: text (required); kind: enum(email\|phone\|handle) (required); value: text (required); note: text |

## health

| Type | Parent | Fields |
| --- | --- | --- |
| `health.condition` | — | name: text (required); since: date; note: text |
| `health.allergy` | — | name: text (required); severity: enum(mild\|moderate\|severe); note: text |
| `health.medication` | — | name: text (required); dose: text; schedule: text; note: text |

## finances

| Type | Parent | Fields |
| --- | --- | --- |
| `finances.budget` | — | name: text (required); amount: number (required); currency: text (required); period: enum(weekly\|monthly\|yearly); note: text |
| `finances.goal` | — | name: text (required); amount: number (required); currency: text (required); by: date; note: text |
| `finances.subscription` | — | name: text (required); amount: number (required); currency: text (required); period: enum(weekly\|monthly\|yearly); note: text |

## preferences

| Type | Parent | Fields |
| --- | --- | --- |
| `preferences.food` | — | name: text (required); note: text |
| `preferences.food.cuisine` | preferences.food | name: text (required); strength: number; note: text |
| `preferences.food.dish` | preferences.food | name: text (required); note: text |
| `preferences.food.restriction` | preferences.food | name: text (required); kind: enum(allergy\|diet\|dislike) (required); severity: enum(mild\|moderate\|severe); note: text |
| `preferences.music` | — | name: text (required); note: text |
| `preferences.music.genre` | preferences.music | name: text (required); note: text |
| `preferences.music.artist` | preferences.music | name: text (required); note: text |
| `preferences.travel` | — | name: text (required); note: text |
| `preferences.travel.style` | preferences.travel | name: text (required); note: text |
| `preferences.travel.place` | preferences.travel | name: text (required); note: text |

## relationships

| Type | Parent | Fields |
| --- | --- | --- |
| `relationships.person` | — | name: text (required); relation: enum(partner\|family\|friend\|colleague\|other); note: text |
| `relationships.person.detail` | relationships.person | name: text (required); value: text; note: text |
| `relationships.pet` | — | name: text (required); species: text; note: text |

## schedule

| Type | Parent | Fields |
| --- | --- | --- |
| `schedule.routine` | — | name: text (required); days: enum_list(monday\|tuesday\|wednesday\|thursday\|friday\|saturday\|sunday); time: text; note: text |
| `schedule.event` | — | name: text (required); starts: date; ends: date; place: text; note: text |

## work

| Type | Parent | Fields |
| --- | --- | --- |
| `work.employer` | — | name: text (required); city: text; note: text |
| `work.role` | — | name: text (required); since: date; note: text |
| `work.project` | — | name: text (required); note: text |

## Links

| Link | From | To |
| --- | --- | --- |
| `attends` | identity.person, relationships.person | schedule.event |
| `works_with` | identity.person, relationships.person | identity.person, relationships.person |
| `prefers_over` | preferences.food.cuisine, preferences.food.dish, preferences.music.genre, preferences.music.artist, preferences.travel.style, preferences.travel.place | preferences.food.cuisine, preferences.food.dish, preferences.music.genre, preferences.music.artist, preferences.travel.style, preferences.travel.place |
| `related_to` | relationships.person | relationships.person |
| `lives_at` | identity.person, relationships.person | identity.location |
| `works_at` | identity.person, relationships.person | work.employer |

