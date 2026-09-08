# `rp.state` v2 reference

## Projection

`rp_state_read` with `action: "list"` returns `protocolVersion: 2`, the story `revision`, and a `namespaces` array of namespace summaries. Use each summary's own `revision` for its `expectedRevision`, never the top-level story revision. With `action: "get"`, it returns `protocolVersion: 2`, `namespace`, and the full namespace fields:

- `revision`: namespace CAS version;
- `initialValue`: immutable reset baseline until an explicit configuration update;
- `value`: current plain JSON value;
- `definition`: `title`, optional `description`, `updateMode`, restricted `schema`, and semantic `rules`;
- `diagnostics.setup`: durable initialization diagnostics;
- `diagnostics.lastCommit`: diagnostics from only the latest successful commit.

Use Session-local paths such as `/characters/李钰/好感度`. A namespace is only a partition ID, never a character owner or asset alias. `story` is the default initialization namespace.

## Restricted schema

Allowed keywords are:

- common: `type`, `title`, `description`, `enum`, `const`;
- object: `properties`, `required`, `additionalProperties`;
- array: `items`, `minItems`, `maxItems`;
- number: `minimum`, `maximum`;
- string: `minLength`, `maxLength`.

`type` is one JSON type or a finite array of JSON types. Do not use `$ref`, composition or conditional schemas, patterns, scripts, custom keywords, or unknown fields. The definition, initial value, and current value must all validate.

## Rules and update modes

A definition rule has stable `id`, JSON-Pointer `target`, semantic `when`, optional machine `condition`, an `effect`, optional `guidance`, and optional `cadence` (`when-applicable` by default, or `every-turn`). In `state_commit_contract`, `id` is rendered as `ruleId` and `effect.op` as `op`. Supported effects are `set`, `increment`, `append`, and `remove`; increment effects may bound `minimum` and `maximum` deltas, not the final value.

- `rules-required`: every change needs a listed `ruleId` from that namespace whose target equals the change path and whose operation matches. Target, operation, increment bounds, and condition are enforced; never guess an ID or use an ancestor/group rule ID for a child path.
- `schema-only`: follow semantic guidance, but a `ruleId` is optional. If supplied, it must still exist and satisfy exact target/operation matching, bounds, and condition. Operations and the final schema always apply.
- `disabled`: State is readable but story commits cannot change it.

`when` and `guidance` explain semantic judgment. Only `condition` is machine-evaluated, immediately before its change and including earlier changes/effects in the same commit. Review `every-turn` rules, but submit only changed values. Omission diagnostics use pre-commit state for their conditions and can warn even when an unchanged value needs no update; they do not reject the commit or require no-op changes.

The live contract supplies `valueSchema` for `set` and `append`, `resultSchema` for the number after `increment`, and `parentSchema` for the container after `remove`. Respect required keys and array `minItems`; a configured rule ID does not override schema constraints.

## Commit shape

Use one effect per namespace:

```json
{
  "kind": "state.update",
  "namespace": "story",
  "expectedRevision": 4,
  "payload": {
    "changes": [
      {
        "op": "increment",
        "path": "/characters/李钰/好感度",
        "by": 2,
        "ruleId": "liyu-affection-normal-positive",
        "reason": "李钰主动分享了此前隐瞒的经历，信任有所增加"
      }
    ]
  }
}
```

`set` uses a complete replacement `value`, never a merge; `increment` uses finite `by`; `append` uses one item in `value`; `remove` has neither `value` nor `by`. Every change needs a non-whitespace `reason`. A new object key may be set if its parent exists and the final schema permits it; array `set` requires an existing index. Root removal, missing targets where the operation requires an existing value, scripts, merge operations, duplicate paths, and ancestor/descendant path conflicts are invalid. Changes run in order but commit atomically only after all rules and the final schema pass. If no values changed, omit `effects` or use `[]`; never send an effect with empty `changes`.

## Failed commit corrections

One successful commit ends the narrative turn; a rejected attempt may be corrected and retried. Copy the latest `retry.token` and send only `retry`, with up to 64 `patches`. The patch path addresses the cached `runSummary`, `effects`, `references`, or `extensions`, not a raw State value. For a missing `ruleId`, use `add` at the reported `/effects/.../ruleId` path with the matching ID; `replace` requires an existing field. Correct all reported issues together. Empty patches only revalidate the unchanged draft and cannot repair a validation failure.

The selected prose is cached separately and cannot be patched; do not include `narrative` in a correction-only call. Do not supply parent-authored extensions; enabled reply options are runtime-generated. A rejected commit has not persisted any of its narrative effects.

## Condition language

World-book `stateCondition` and rule `condition` support only:

- `state(namespace, jsonPointer)` and `exists(namespace, jsonPointer)`;
- JSON scalar literals and parentheses;
- `!`, `&&`, `||`, `==`, `!=`, `>`, `>=`, `<`, and `<=`.

Do not use aliases, property access, arithmetic, arbitrary functions, or executable code. Missing paths, type mismatches, and malformed expressions evaluate inactive and produce diagnostics.

## Explicit configuration

`rp_state` is Agent-only and supports `create`, `update`, `reset`, and `delete` after an explicit user request. `create` requires `expectedRevision: 0`. `update` replaces the complete definition and conditionally replaces complete values. `reset` copies `initialValue` to `value`. `delete` removes the namespace. A successful configuration takes effect immediately and is owned by the model assistant message that invoked the tool. Editing only that reply's text preserves it; deleting or regenerating the reply retracts it and rebuilds the projection from the remaining bootstrap, configuration, and turn-commit entities before replay starts. Bootstrap initialization is not message-owned and is never retracted this way.
